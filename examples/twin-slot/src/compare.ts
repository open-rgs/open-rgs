// Run the SAME seeded RNG stream through the Lua slot and the Zig/WASM slot and
// watch them produce identical outcomes - to the engine they're interchangeable.
//
//   bun examples/twin-slot/src/compare.ts
//
// (This is the human-readable demo; test/twin-slot.test.ts is the CI proof.)

import { resolve } from "node:path";
import { loadLuaMath, loadWasmMath } from "../../../packages/core/src/index.js";
import type { SimpleMath, RoundOutcome } from "../../../packages/contract/src/index.js";

// Deterministic DEMO-ONLY PRNG so both runtimes draw the same stream. Real
// outcomes use a CSPRNG (loadXMath defaults to cryptoRng).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Structural key (sorted keys) so {kind,mult} == {mult,kind}.
const canon = (x: unknown): unknown =>
  Array.isArray(x) ? x.map(canon)
    : x && typeof x === "object" ? Object.fromEntries(Object.keys(x as object).sort().map(k => [k, canon((x as Record<string, unknown>)[k])]))
      : x;
const same = (a: RoundOutcome, b: RoundOutcome): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const fmt = (o: RoundOutcome): string => `x${o.multiplier} ${o.type}`.padEnd(11);

const here = import.meta.dir;
const seed = 12345;
const ctx = { mode: "default" } as const;

const lua = (await loadLuaMath(resolve(here, "../maths/slot.lua"), { rng: mulberry32(seed), timeoutMs: 0 })) as SimpleMath;
const wasm = (await loadWasmMath(resolve(here, "../maths/slot.wasm"), { rng: mulberry32(seed) })) as SimpleMath;

console.log(`twin-slot - same game in two runtimes, same RNG stream (seed ${seed})\n`);
console.log(`  spin   lua          wasm         match`);
for (let i = 0; i < 12; i++) {
  const a = await lua.play(undefined, ctx);
  const b = await wasm.play(undefined, ctx);
  console.log(`  #${String(i + 1).padStart(2)}    ${fmt(a)}  ${fmt(b)}  ${same(a, b) ? "yes" : "NO <-- DIFF"}`);
}

// Confirm at scale + report the measured RTP.
let identical = 0;
let sum = 0;
const N = 100_000;
for (let i = 0; i < N; i++) {
  const a = await lua.play(undefined, ctx);
  const b = await wasm.play(undefined, ctx);
  if (same(a, b)) identical++;
  sum += a.multiplier;
}
console.log(`\n  ${identical.toLocaleString()}/${N.toLocaleString()} further spins identical`);
console.log(`  measured RTP (lua) over ${N.toLocaleString()} spins: ${(sum / N).toFixed(4)}  (target 0.96)`);
