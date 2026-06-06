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

const ctx = { mode: "default" } as const;
const here = import.meta.dir;
// cheap, varying DEMO-only rng so we measure the runtime, not the RNG.
const makeCheap = (): (() => number) => { let x = 0.123; return () => { x = (x + 0.6180339887498949) % 1; return x; }; };

function bench(fn: () => unknown, n: number, reps = 7): number {
  for (let i = 0; i < (n >> 2); i++) fn(); // warm up
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, performance.now() - t);
  }
  return (best / n) * 1e6; // ns per call
}

const luaOn = (await loadLuaMath(resolve(here, "../maths/slot.lua"), { rng: makeCheap() })) as SimpleMath;
const luaOff = (await loadLuaMath(resolve(here, "../maths/slot.lua"), { rng: makeCheap(), timeoutMs: 0 })) as SimpleMath;
const wasm = (await loadWasmMath(resolve(here, "../maths/slot.wasm"), { rng: makeCheap() })) as SimpleMath;

const N = 300_000;
const a = bench(() => luaOn.play(undefined, ctx), N);
const b = bench(() => luaOff.play(undefined, ctx), N);
const c = bench(() => wasm.play(undefined, ctx), N);

console.log(`twin-slot - per play() call (${N.toLocaleString()} calls x7, best rep)\n`);
console.log(`  lua  (watchdog on, default):  ${a.toFixed(0).padStart(6)} ns`);
console.log(`  lua  (watchdog off):          ${b.toFixed(0).padStart(6)} ns`);
console.log(`  wasm (zig):                   ${c.toFixed(0).padStart(6)} ns`);
console.log(`\n  -> wasm is ${(a / c).toFixed(1)}x faster than Lua (default), ${(b / c).toFixed(1)}x with the watchdog off`);
