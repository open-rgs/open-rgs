// TS math loader. Loads a TypeScript/JavaScript math module and adapts it to a
// MathModule - the orchestrator can't tell it from a Lua or WASM math.
//
// Why a loader at all, when a TS math is "just an import"? Two guarantees the
// other tiers get for free and a bare `import()` does not:
//
//   1. THE RNG SEAM. Lua math draws through the `host` global; a WASM kernel
//      imports `host.rng_next`. Neither can reach an ambient generator. A TS
//      module can - `Math.random()` is one identifier away, it looks correct,
//      it passes every test you would think to write, and it silently destroys
//      seed reproducibility. So a TS math does NOT default-export a math
//      object; it default-exports a FACTORY taking the host (contract
//      `MathFactory`). Randomness arrives by injection, same as everywhere else.
//
//   2. PURITY. `assertPure` below rejects a module that reaches for ambient
//      randomness, the clock, I/O, or an implementation-defined float op,
//      BEFORE the module is imported and evaluated.
//
// WHAT THE PURITY CHECK IS AND IS NOT. It is a guardrail against ACCIDENTS -
// overwhelmingly, a math author (increasingly a language model) reaching for
// `Math.random()` or `Date.now()` because that is the obvious thing to write.
// It is NOT a sandbox: a determined author evades a source scan trivially
// (`globalThis["Ma"+"th"]`), and once the module is imported it runs with the
// host's full authority. If you need to run math you do not trust, use the
// WASM tier, which is sandboxed by construction. This tier assumes math is
// authored by the same party that operates the server - which is the documented
// trust model for open-rgs deployments (spec 00).
//
// The check therefore FAILS CLOSED and errs toward false positives: a rejected
// module is a clear boot-time error, an accepted impure one is a silent
// certification void.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { MathHost, MathModule, MathFactory } from "@open-rgs/contract";
import { log } from "./log.js";
import { resolveRng } from "./lua-math.js";

/** A math whose every entry-point call is reconstructable from one recorded
 *  number. Returned by {@link loadTsMath} under `rngMode: "seed-expand"`. */
export interface Replayable {
  /** Seed the most recent entry-point call ran on. Record it alongside the
   *  round and the round replays exactly. Integer below 2^53, so it survives
   *  JSON and an audit log without special handling. */
  readonly lastSeed: number;
  /** Re-run an entry point on an explicit seed instead of drawing a fresh one.
   *  Given the same seed and the same carry, the outcome is identical - that is
   *  the whole replay guarantee. */
  withSeed<T>(seed: number, fn: () => T): T;
}

export interface LoadTsMathOptions {
  /** Outcome RNG, exposed to the factory as `host.rng_next`. Same policy as
   *  loadLuaMath: defaults to the secure system CSPRNG (cryptoRng);
   *  production fails closed without an explicit choice. */
  rng?: () => number;
  /** Permit booting without an injected rng under NODE_ENV=production (uses the
   *  secure default), and a tagged simulator PRNG in prod. Tooling only. */
  allowInsecureRng?: boolean;
  /** Sink for `host.log_debug`. Omitted = no-op. */
  onDebug?: (message: string) => void;
  /** Skip the purity check. Intended for the conformance suite's own negative
   *  fixtures - NEVER for production math. Logs a warning when set. */
  unsafeSkipPurityCheck?: boolean;
  /** How randomness reaches the math.
   *
   *  `"per-draw"` (default): every `host.rng_next()` calls the injected `rng`
   *  directly. With a CSPRNG that is unpredictable - and UNREPLAYABLE, because
   *  a CSPRNG has no seed to write down.
   *
   *  `"seed-expand"`: draw ONE seed per entry-point call from `rng`, then
   *  expand it deterministically for the draws within that call. The math sees
   *  the same uniform stream; the difference is that the whole call now
   *  collapses to a single recordable number, so `withSeed(seed, ...)`
   *  reproduces it exactly.
   *
   *  Note this is a REPLAY feature here, not a performance one. In the Lua tier
   *  seed-expand exists mainly to dodge per-draw JS<->WASM crossings; in-process
   *  TS has no boundary to dodge, so the only thing it buys is reproducibility -
   *  which is the reason to want it.
   *
   *  CERT NOTE: under `"seed-expand"` the expansion enters the
   *  outcome-determination path and must be evaluated as part of the RNG.
   *  Default stays `"per-draw"`. */
  rngMode?: "per-draw" | "seed-expand";
}

/** splitmix32 - used only to spread one seed into generator state. */
function splitmix32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** sfc32 - small, fast, passes PractRand. Deterministic from its state, which
 *  is the entire point: the state comes from one seed, so the stream does too. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/** Expand a seed into a uniform stream over [0, 1) with full 53-bit
 *  resolution. Two 32-bit draws per float: a 32-bit float would cap the number
 *  of distinct boards a draw-heavy spin can produce, which is a real limit on a
 *  big grid rather than a theoretical one. */
function streamFromSeed(seed: number): () => number {
  const sm = splitmix32(seed ^ 0x9e3779b9);
  const gen = sfc32(sm(), sm(), sm(), sm());
  for (let i = 0; i < 12; i++) gen(); // discard, so nearby seeds diverge
  return () => {
    const hi = gen() >>> 5;   // 27 bits
    const lo = gen() >>> 6;   // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992; // / 2^53
  };
}

/** Wrap every entry point so each call reseeds independently, exactly as the
 *  Lua tier documents. Reseeding per call (rather than once per load) is what
 *  makes a single round replayable in isolation - you need not replay the whole
 *  session to reach it. */
function createSeedExpand(drawSeed: () => number): {
  rng_next: () => number;
  wrap: (m: MathModule) => MathModule & Replayable;
} {
  let stream: () => number = () => {
    throw new Error("loadTsMath: math drew randomness outside an entry-point call");
  };
  let lastSeed = 0;
  let forced: number | undefined;

  const rng_next = () => stream();

  const begin = () => {
    const seed = forced ?? drawSeed();
    lastSeed = seed;
    stream = streamFromSeed(seed);
  };

  const wrap = (m: MathModule): MathModule & Replayable => {
    const seeded = <A extends unknown[], R>(fn: ((...a: A) => R) | undefined) =>
      fn === undefined ? undefined : (...args: A): R => { begin(); return fn(...args); };

    const out = Object.create(m) as MathModule & Replayable & Record<string, unknown>;
    for (const key of ["play", "open", "step", "close", "autoclose"] as const) {
      const fn = (m as unknown as Record<string, unknown>)[key];
      if (typeof fn === "function") out[key] = seeded((fn as (...a: unknown[]) => unknown).bind(m));
    }
    // isTerminal is a pure predicate over state - it must NOT reseed, or asking
    // whether a round is finished would consume a seed and shift the stream.
    Object.defineProperty(out, "lastSeed", { get: () => lastSeed, enumerable: true });
    out["withSeed"] = <T>(seed: number, fn: () => T): T => {
      forced = seed;
      try { return fn(); } finally { forced = undefined; }
    };
    return out as MathModule & Replayable;
  };

  return { rng_next, wrap };
}

/** Identifiers a math module must not reference, and why. Grouped so the error
 *  can tell the author which guarantee they broke rather than just "denied". */
const FORBIDDEN: ReadonlyArray<{ readonly re: RegExp; readonly why: string }> = [
  {
    re: /\bMath\s*\.\s*random\b|\bcrypto\b|\bgetRandomValues\b/,
    why: "ambient randomness - draw through host.rng_next() so outcomes replay from a seed",
  },
  {
    re: /\bDate\b|\bperformance\s*\.\s*now\b|\bhrtime\b/,
    why: "the clock - math must be a pure function of (seed, state); a clock read makes a round unreplayable",
  },
  {
    re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bprocess\b|\brequire\s*\(|\bimport\s*\(/,
    why: "I/O - math runs on the hot path with no network, no filesystem, no environment",
  },
  {
    re: /\bglobalThis\b|\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/,
    why: "a dynamic escape hatch - it defeats the point of this check",
  },
  {
    // Correctly-rounded ops (floor/ceil/round/trunc/abs/min/max/sign/sqrt/fround)
    // are fine. These are implementation-defined and may differ across engines
    // and versions, so an RTP certified on one build is not reproducible on
    // another. WASM float ops ARE bit-deterministic - use that tier if a game
    // genuinely needs a transcendental.
    re: /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|cbrt|hypot)\b/,
    why: "an implementation-defined float op - results may differ across engines, so a certified RTP would not reproduce",
  },
];

/** Strip comments and quoted strings so the scan reads code, not prose. A
 *  denylist term inside a comment ("do not call Math.random here") must not
 *  trip the check.
 *
 *  Template literals are deliberately LEFT INTACT: their `${...}` holes are
 *  real code, and stripping the whole literal would hide `${Math.random()}`.
 *  The cost is a false positive if a template's literal text happens to spell
 *  a denied term, which fails closed with a clear message - the safe direction. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")     // block comments
    .replace(/\/\/[^\n]*/g, " ")           // line comments
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''") // single-quoted
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""'); // double-quoted
}

/** Throw unless `src` is free of ambient randomness, clock reads, I/O, dynamic
 *  escape hatches, and implementation-defined float ops. Exported so the
 *  simulator and CI can run it over a math file without loading it. */
export function assertPure(src: string, path: string): void {
  const code = stripCommentsAndStrings(src);
  const hits = FORBIDDEN.filter((f) => f.re.test(code));
  if (hits.length === 0) return;
  throw new Error(
    `loadTsMath(${path}): math module is not pure. ` +
      hits.map((h) => `Found ${h.why}.`).join(" ") +
      ` Math draws only through host.rng_next() and must be a pure function of ` +
      `(seed, state). If this game genuinely needs one of these, it belongs in ` +
      `the WASM tier (loadWasmMath), which is sandboxed and bit-deterministic.`,
  );
}

/**
 * Load a TS/JS math module.
 *
 * The module must default-export a {@link MathFactory} - a function taking the
 * host and returning the math:
 *
 * ```ts
 * export default (host: MathHost): SimpleMath => ({
 *   kind: "simple", name: "my-slot", version: "1.0.0", rtp: 0.96,
 *   play: () => { const r = host.rng_next(); ... },
 * });
 * ```
 */
export async function loadTsMath(path: string, opts: LoadTsMathOptions = {}): Promise<MathModule> {
  const src = await readFile(path, "utf8");

  if (opts.unsafeSkipPurityCheck) {
    log.warn("loadTsMath: purity check SKIPPED - this math may reach ambient randomness, the clock, or I/O", {
      "event.category": "process",
      "event.action": "ts_math_purity_skipped",
      "math.path": path,
    });
  } else {
    assertPure(src, path);
  }

  const rng = resolveRng(path, opts, "loadTsMath");

  // Under seed-expand the math draws from a stream expanded from one seed per
  // entry-point call, so the call collapses to a recordable number. 2^53 seeds,
  // not 2^32: a 32-bit seed would cap how many distinct boards a draw-heavy
  // spin can produce, which is a real ceiling on a big grid.
  const seedExpand = opts.rngMode === "seed-expand";
  const expand = seedExpand
    ? createSeedExpand(() => Math.floor(rng() * 9007199254740992))
    : undefined;

  const host: MathHost = {
    rng_next: expand ? expand.rng_next : rng,
    log_debug: opts.onDebug ?? (() => {}),
  };

  // Cache-bust so `reload()` semantics match the Lua loader: a second load of
  // the same path picks up edited source rather than the module cache.
  const url = `${pathToFileURL(path).href}?v=${createHash("sha256").update(src).digest("hex").slice(0, 16)}`;
  const mod = (await import(url)) as { default?: unknown };

  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `loadTsMath(${path}): default export must be a factory function (host) => MathModule, got ${typeof factory}. ` +
        `A bare math object has no RNG seam - see contract MathFactory.`,
    );
  }

  const math = (factory as MathFactory)(host);
  // Read `kind` before the guard: inside the failure branch TS has narrowed
  // `math` to `never`, so it can no longer be used to build the message.
  const kind: unknown = math?.kind;
  if (!math || (kind !== "simple" && kind !== "complex")) {
    throw new Error(
      `loadTsMath(${path}): factory returned ${math ? `kind '${String(kind)}'` : "nothing"}; expected "simple" or "complex".`,
    );
  }

  // Same provenance stamp the Lua and WASM loaders apply: the audit log can
  // prove which source computed a given outcome. Together with `lastSeed` and
  // the round's carry, that is everything needed to reconstruct a round:
  // WHICH math (contentHash), from WHAT state (carry), on WHICH stream (seed).
  const stamped = Object.assign(math, {
    contentHash: createHash("sha256").update(src).digest("hex"),
  });
  return expand ? expand.wrap(stamped) : stamped;
}
