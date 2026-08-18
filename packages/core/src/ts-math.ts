// TS math loader. Loads a TypeScript/JavaScript math module and adapts it to a
// MathModule - the orchestrator can't tell it from a WASM math.
//
// Why a loader at all, when a TS math is "just an import"? Two guarantees the
// other tiers get for free and a bare `import()` does not:
//
//   1. THE RNG SEAM. A WASM kernel imports `host.rng_next` and cannot reach
//      an ambient generator. A TypeScript module can - `Math.random()` is one identifier away, it looks correct,
//      it passes every test you would think to write, and it silently destroys
//      seed reproducibility. So a TS math does NOT default-export a math
//      object; it default-exports a FACTORY taking the host (contract
//      `MathFactory`). Randomness arrives by injection, same as everywhere else.
//
//   2. PURITY. `assertPure` below rejects a module that reaches for ambient
//      randomness, the clock, I/O, or an implementation-defined float op,
//      BEFORE the module is imported and evaluated. It runs over the whole
//      math - the entry file and every local file it imports - because a math
//      split across files is the ordinary way to write one, and a gate that
//      reads only the entry catches nothing that lives one import away.
//
// What the purity check is and is not. It is a guardrail against ACCIDENTS -
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
import { dirname, resolve as resolvePath, relative as relativePath, isAbsolute } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import type { MathHost, MathModule, MathFactory } from "@open-rgs/contract";
import { log } from "./log.js";
import { resolveRng } from "./rng.js";

/** A math whose every entry-point call is reconstructable from one recorded
 *  number. Returned by {@link loadTsMath} under `rngMode: "seed-expand"`. */
export interface Replayable {
  /** Seed the most recently STARTED entry-point call ran on.
   *
   *  Correct when calls do not overlap - a synchronous math, which is the
   *  common case. When two rounds are in flight at once this reads whichever
   *  started last, so a caller that records seeds under concurrency should use
   *  {@link runSeeded}, which hands back the seed belonging to ITS call. */
  readonly lastSeed: number;
  /** Re-run an entry point on an explicit seed instead of drawing a fresh one.
   *  Given the same seed and the same carry, the outcome is identical - that is
   *  the whole replay guarantee. The seed applies to this call only; a
   *  concurrent round is unaffected. */
  withSeed<T>(seed: number, fn: () => T): T;
  /** Draw a seed, run `fn` on it, and return BOTH - so the recorded seed is
   *  unambiguously the one that call ran on, no matter what else is in flight.
   *  `fn` may be async; the stream follows it across awaits. */
  runSeeded<T>(fn: () => T | Promise<T>): { seed: number; result: T | Promise<T> };
}

export interface LoadTsMathOptions {
  /** Outcome RNG, exposed to the factory as `host.rng_next`. Same policy as
   *  loadTsMath: defaults to the secure system CSPRNG (cryptoRng);
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
   *  This is a REPLAY feature, not a performance one: in-process TypeScript has
   *  no boundary to dodge, so the only thing it buys is reproducibility - which
   *  is the reason to want it.
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

/** Wrap every entry point so each call runs on its OWN stream, seeded from its
 *  own draw. Per call, not per load: a round replays in isolation, without
 *  replaying the session that led to it.
 *
 *  CONCURRENCY. The stream, the recorded seed and the forced-seed override used
 *  to be three variables shared by every call into the math. Any math that
 *  awaits - and the orchestrator awaits every call - let a second player's
 *  round reseed the stream halfway through the first, so both rounds drew from
 *  a spliced stream, `lastSeed` held whichever call began most recently, and
 *  replaying that seed reproduced neither round. Per-session serialization does
 *  not help, because the collision is across sessions.
 *
 *  So the stream lives in the call, held by an async-local store that follows
 *  the call across its awaits. `lastSeed` remains for the synchronous, one-call-
 *  at-a-time case that read it before; the seed is also returned per call
 *  through {@link Replayable.runSeeded}, which is the form that stays correct
 *  under concurrency. */
function createSeedExpand(drawSeed: () => number): {
  rng_next: () => number;
  wrap: (m: MathModule) => MathModule & Replayable;
} {
  interface CallState { stream: () => number; seed: number }
  // The stream belongs to the CALL and follows it across awaits.
  const current = new AsyncLocalStorage<CallState>();
  // A seed pinned by withSeed, visible to the next entry point entered inside
  // it - and only inside it, so a concurrent round still draws its own.
  const forced = new AsyncLocalStorage<number | undefined>();
  let lastSeed = 0;

  const rng_next = (): number => {
    const state = current.getStore();
    if (!state) {
      throw new Error(
        "loadTsMath: math drew randomness outside an entry-point call. Under " +
        "rngMode 'seed-expand' every draw must happen inside play/open/step/" +
        "close/autoclose, so the draw belongs to a round that can be replayed.",
      );
    }
    return state.stream();
  };

  const runOn = <T>(seed: number, fn: () => T): T => {
    lastSeed = seed;
    // Clear the pin as we enter: it applies to THIS entry point, not to
    // whatever it calls in turn.
    return forced.run(undefined, () => current.run({ stream: streamFromSeed(seed), seed }, fn));
  };

  const wrap = (m: MathModule): MathModule & Replayable => {
    const seeded = <A extends unknown[], R>(fn: ((...a: A) => R) | undefined) =>
      fn === undefined ? undefined : (...args: A): R => runOn(forced.getStore() ?? drawSeed(), () => fn(...args));

    const out = Object.create(m) as MathModule & Replayable & Record<string, unknown>;
    for (const key of ["play", "open", "step", "close", "autoclose"] as const) {
      const fn = (m as unknown as Record<string, unknown>)[key];
      if (typeof fn === "function") out[key] = seeded((fn as (...a: unknown[]) => unknown).bind(m));
    }
    // isTerminal is a pure predicate over state - it must NOT reseed, or asking
    // whether a round is finished would consume a seed and shift the stream.
    Object.defineProperty(out, "lastSeed", { get: () => lastSeed, enumerable: true });
    out["withSeed"] = <T>(seed: number, fn: () => T): T => forced.run(seed, fn);
    out["runSeeded"] = <T>(fn: () => T | Promise<T>): { seed: number; result: T | Promise<T> } => {
      const seed = drawSeed();
      return { seed, result: forced.run(seed, fn) };
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


// -. The math's own files ---------------------------------------------------
//
// A math is rarely one file, so the loader collects every file it is built
// from before it scans or hashes anything. Read only the entry and a helper
// module can call `Math.random()` behind the gate's back, while a rewritten
// payout table in that helper leaves the contentHash unchanged - and that hash
// is what the audit log carries as proof of which math computed an outcome.
//
// Only local specifiers are followed (`./x`, `../y`). A package import is a
// dependency: pinned by the lockfile, outside the author's file tree, and
// following it would scan the whole node_modules closure to no purpose.

/** Graph hash per entry path, so a second load can tell the author their edit
 *  is not being picked up (see loadTsMath). */
const LOADED_GRAPHS = new Map<string, string>();

/** Extensions tried for an extensionless or `.js`-written specifier - the
 *  TypeScript convention of importing `./x.js` for `./x.ts` included. */
const RESOLVE_ORDER = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"] as const;

/** Static import/export specifiers. Dynamic `import()` is rejected by the
 *  purity gate, so it cannot appear in a file that passes. */
const SPECIFIER_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']/g;

async function readIfFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** Resolve one local specifier against the importing file. Returns the path and
 *  its source, or undefined when nothing on disk matches (a type-only import of
 *  a `.d.ts`, say - nothing to scan, nothing to hash). */
async function resolveLocal(fromFile: string, spec: string): Promise<{ path: string; src: string } | undefined> {
  const base = resolvePath(dirname(fromFile), spec);
  const candidates: string[] = [base];
  const dot = base.lastIndexOf(".");
  const slash = base.lastIndexOf("/");
  const hasExt = dot > slash;
  if (hasExt) {
    // `./x.js` in TypeScript source usually means `./x.ts` on disk.
    const stem = base.slice(0, dot);
    for (const ext of RESOLVE_ORDER) candidates.push(stem + ext);
  } else {
    for (const ext of RESOLVE_ORDER) candidates.push(base + ext);
    for (const ext of RESOLVE_ORDER) candidates.push(`${base}/index${ext}`);
  }
  for (const c of candidates) {
    const src = await readIfFile(c);
    if (src !== undefined) return { path: c, src };
  }
  return undefined;
}

/** Every local file the math is made of, entry first, each visited once. */
export async function collectMathSources(entry: string): Promise<Array<{ path: string; src: string }>> {
  const entrySrc = await readFile(entry, "utf8");
  const out: Array<{ path: string; src: string }> = [{ path: resolvePath(entry), src: entrySrc }];
  const seen = new Set<string>([resolvePath(entry)]);
  const queue: Array<{ path: string; src: string }> = [{ path: resolvePath(entry), src: entrySrc }];

  while (queue.length > 0) {
    const file = queue.shift()!;
    // Read specifiers from the code, not from comments or string literals.
    const code = stripCommentsAndStrings(file.src);
    // stripCommentsAndStrings blanks quoted text, so specifiers are read from
    // the raw source; comments are the only false-positive risk and an import
    // inside a comment resolves to nothing anyway.
    SPECIFIER_RE.lastIndex = 0;
    void code;
    let m: RegExpExecArray | null;
    while ((m = SPECIFIER_RE.exec(file.src)) !== null) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // package import
      const found = await resolveLocal(file.path, spec);
      if (!found || seen.has(found.path)) continue;
      seen.add(found.path);
      out.push(found);
      queue.push(found);
    }
  }
  return out;
}

/** Content hash over the WHOLE math, not just its entry file. Paths are made
 *  relative to the entry's directory and sorted, so the same math hashes the
 *  same on a developer's laptop and in a container. */
export function hashMathSources(entry: string, files: ReadonlyArray<{ path: string; src: string }>): string {
  const root = dirname(resolvePath(entry));
  const h = createHash("sha256");
  const rows = files
    .map((f) => {
      const rel = relativePath(root, f.path);
      // A file outside the entry's tree keeps an absolute-ish marker rather
      // than a "../.." that would differ per checkout depth.
      return { key: isAbsolute(rel) || rel.startsWith("..") ? `external:${f.path.split("/").slice(-2).join("/")}` : rel, src: f.src };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const r of rows) {
    h.update(r.key);
    h.update("\0");
    h.update(r.src);
    h.update("\0");
  }
  return h.digest("hex");
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
  // Every local file the math is built from - the entry plus everything it
  // imports, transitively. The gate and the hash both cover all of it.
  const files = await collectMathSources(path);
  const src = files[0]!.src;

  if (opts.unsafeSkipPurityCheck) {
    log.warn("loadTsMath: purity check SKIPPED - this math may reach ambient randomness, the clock, or I/O", {
      "event.category": "process",
      "event.action": "ts_math_purity_skipped",
      "math.path": path,
    });
  } else {
    for (const f of files) assertPure(f.src, f.path);
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

  // Identity of the whole math: the provenance stamp below, and the cache-bust
  // for the entry module.
  //
  // What the cache-bust can and cannot do. The query re-imports the ENTRY.
  // Its imports are cached under their own URLs, which nothing here rewrites,
  // so a second load in the same process picks up an edited entry and keeps the
  // already-imported helpers. The hash below sees the edit even when the module
  // graph does not, so we can at least say so instead of silently running the
  // old code. Reloading edited math for real means a fresh process.
  const contentHash = hashMathSources(path, files);
  const seenHash = LOADED_GRAPHS.get(resolvePath(path));
  if (seenHash !== undefined && seenHash !== contentHash) {
    log.warn("loadTsMath: math source changed since this process last loaded it  - " +
      "imported files are already in the module cache and will NOT be re-imported. " +
      "Restart the process to run the edited math.", {
      "event.category": "process",
      "event.action": "ts_math_stale_reload",
      "math.path": path,
      "math.content_hash.previous": seenHash.slice(0, 16),
      "math.content_hash.current": contentHash.slice(0, 16),
    });
  }
  LOADED_GRAPHS.set(resolvePath(path), contentHash);
  const url = `${pathToFileURL(path).href}?v=${contentHash.slice(0, 16)}`;
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
  // `math` to `never`, so the message cannot be built from it there.
  const kind: unknown = math?.kind;
  if (!math || (kind !== "simple" && kind !== "complex")) {
    throw new Error(
      `loadTsMath(${path}): factory returned ${math ? `kind '${String(kind)}'` : "nothing"}; expected "simple" or "complex".`,
    );
  }

  // Same provenance stamp the WASM loader applies: the audit log can
  // prove which source computed a given outcome. Together with `lastSeed` and
  // the round's carry, that is everything needed to reconstruct a round:
  // WHICH math (contentHash, over every file it is made of), from WHAT state
  // (carry), on WHICH stream (seed).
  const stamped = Object.assign(math, { contentHash });
  return expand ? expand.wrap(stamped) : stamped;
}
