// Head-to-head speed: the SAME slot math as in-process TS vs a Zig/WASM kernel.
// Run it on your own hardware - the *ratio* is fairly stable, the absolute ns
// are machine- and Bun-version-dependent.
//
//   bun examples/twin-slot/src/bench.ts
//
// What dominates is the BOUNDARY, not the language: a WASM kernel round-trips
// MessagePack through linear memory, while in-process TS crosses nothing at all.
// The RNG itself is a rounding error either way (try cryptoRng - the ratio
// barely moves), so we time the runtime with a cheap rng.

import { resolve } from "node:path";
import { loadWasmMath } from "../../../packages/core/src/index.js";
import type { SimpleMath } from "../../../packages/contract/src/index.js";
import createTsMath from "../maths/slot.ts";

const ctx = { mode: "default" } as const;
const here = import.meta.dir;
// cheap, varying DEMO-only rng so we measure the runtime, not the RNG.
const makeCheap = (): (() => number) => { let x = 0.123; return () => { x = (x + 0.6180339887498949) % 1; return x; }; };

// The result is ACCUMULATED, not discarded. An in-process TS math is a plain
// call JSC can scalar-replace and dead-code-eliminate if nothing reads the
// outcome - which would report a fictional number for the TS tier while the
// WASM tier, whose work crosses a boundary, stays honest. Summing the
// multiplier (and printing the sink) keeps every tier doing real work.
let sink = 0;
function bench(fn: () => { multiplier: number }, n: number, reps = 7): number {
  for (let i = 0; i < (n >> 2); i++) sink += fn().multiplier; // warm up
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) sink += fn().multiplier;
    best = Math.min(best, performance.now() - t);
  }
  return (best / n) * 1e6; // ns per call
}

const wasm = (await loadWasmMath(resolve(here, "../maths/slot.wasm"), { rng: makeCheap() })) as SimpleMath;

const ts = createTsMath({ rng_next: makeCheap(), log_debug: () => {} }) as SimpleMath;

const N = 300_000;
const c = bench(() => wasm.play(undefined, ctx) as { multiplier: number }, N);
const d = bench(() => ts.play(undefined, ctx) as { multiplier: number }, N);

const rate = (ns: number) => (1e9 / ns).toLocaleString(undefined, { maximumFractionDigits: 0 });

console.log(`twin-slot - per play() call (${N.toLocaleString()} calls x7, best rep)\n`);
console.log(`  wasm (zig):                   ${c.toFixed(0).padStart(6)} ns   ${rate(c).padStart(13)} spins/s`);
console.log(`  ts   (in-process):            ${d.toFixed(0).padStart(6)} ns   ${rate(d).padStart(13)} spins/s`);
console.log(`\n  -> ts is ${(c / d).toFixed(1)}x faster than the Zig/WASM kernel - the boundary, not the language`);
console.log(`
  (sink ${sink} - proves no tier was optimized away)`);
