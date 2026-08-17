// Head-to-head speed: the SAME slot math in Lua vs Zig/WASM. This is the
// reproducer behind the docs' "~14x faster than Lua" figure - run it on your own
// hardware. The *ratio* is fairly stable; the absolute ns are machine- and
// Bun-version-dependent.
//
//   bun examples/twin-slot/src/bench.ts
//
// What dominates: wasmoon marshals a fresh Lua table across the JS<->Lua bridge
// on every call; the WASM kernel just writes MessagePack into linear memory. The
// RNG itself is a rounding error either way (try cryptoRng - the ratio barely
// moves), so we time the runtime with a cheap rng.

import { resolve } from "node:path";
import { loadLuaMath, loadWasmMath } from "../../../packages/core/src/index.js";
import type { SimpleMath } from "../../../packages/contract/src/index.js";
import createTsMath from "../maths/slot.ts";

const ctx = { mode: "default" } as const;
const here = import.meta.dir;
// cheap, varying DEMO-only rng so we measure the runtime, not the RNG.
const makeCheap = (): (() => number) => { let x = 0.123; return () => { x = (x + 0.6180339887498949) % 1; return x; }; };

// The result is ACCUMULATED, not discarded. An in-process TS math is a plain
// call JSC can scalar-replace and dead-code-eliminate if nothing reads the
// outcome - which would report a fictional number for the TS tier while the
// Lua/WASM tiers, whose work crosses a boundary, stay honest. Summing the
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

const luaOn = (await loadLuaMath(resolve(here, "../maths/slot.lua"), { rng: makeCheap() })) as SimpleMath;
const luaOff = (await loadLuaMath(resolve(here, "../maths/slot.lua"), { rng: makeCheap(), timeoutMs: 0 })) as SimpleMath;
const wasm = (await loadWasmMath(resolve(here, "../maths/slot.wasm"), { rng: makeCheap() })) as SimpleMath;

const ts = createTsMath({ rng_next: makeCheap(), log_debug: () => {} }) as SimpleMath;

const N = 300_000;
const a = bench(() => luaOn.play(undefined, ctx) as { multiplier: number }, N);
const b = bench(() => luaOff.play(undefined, ctx) as { multiplier: number }, N);
const c = bench(() => wasm.play(undefined, ctx) as { multiplier: number }, N);
const d = bench(() => ts.play(undefined, ctx) as { multiplier: number }, N);

const rate = (ns: number) => (1e9 / ns).toLocaleString(undefined, { maximumFractionDigits: 0 });

console.log(`twin-slot - per play() call (${N.toLocaleString()} calls x7, best rep)\n`);
console.log(`  lua  (watchdog on, default):  ${a.toFixed(0).padStart(6)} ns   ${rate(a).padStart(13)} spins/s`);
console.log(`  lua  (watchdog off):          ${b.toFixed(0).padStart(6)} ns   ${rate(b).padStart(13)} spins/s`);
console.log(`  wasm (zig):                   ${c.toFixed(0).padStart(6)} ns   ${rate(c).padStart(13)} spins/s`);
console.log(`  ts   (in-process):            ${d.toFixed(0).padStart(6)} ns   ${rate(d).padStart(13)} spins/s`);
console.log(`\n  -> wasm is ${(a / c).toFixed(1)}x faster than Lua (default), ${(b / c).toFixed(1)}x with the watchdog off`);
console.log(`  -> ts   is ${(a / d).toFixed(1)}x faster than Lua (default), ${(c / d).toFixed(1)}x vs the Zig/WASM kernel`);
console.log(`
  (sink ${sink} - proves no tier was optimized away)`);
