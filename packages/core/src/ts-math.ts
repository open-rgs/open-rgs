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
  const host: MathHost = {
    rng_next: rng,
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
  // prove which source computed a given outcome.
  return Object.assign(math, {
    contentHash: createHash("sha256").update(src).digest("hex"),
  });
}
