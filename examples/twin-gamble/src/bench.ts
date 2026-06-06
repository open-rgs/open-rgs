// Head-to-head speed for a COMPLEX round: the same fair double-or-nothing in Lua
// vs Zig/WASM, timing a full open + 3 gambles + close. Reproducer for the docs'
// ~14x figure on the complex path - the marshalling cost is paid per call, so a
// multi-call round shows the same gap as a single play().
//
//   bun examples/twin-gamble/src/bench.ts

import { resolve } from "node:path";
import { loadLuaMath, loadWasmMath } from "../../../packages/core/src/index.js";
import type { ComplexMath, PlayerAction, OpenOutcome, StepOutcome } from "../../../packages/contract/src/index.js";

const ctx = { mode: "default" } as const;
const here = import.meta.dir;
const GAMBLE: PlayerAction = { type: "gamble" };

function bench(fn: () => unknown, n: number, reps = 7): number {
  for (let i = 0; i < (n >> 2); i++) fn(); // warm up
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t = performance.now();
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, performance.now() - t);
  }
  return (best / n) * 1e3; // us per round
}

// open + 3 gambles + close. open/step/close are synchronous here (wasmoon's
// bridge and the WASM call both return sync), so we cast rather than await -
// awaiting a non-promise would add a microtask per call and skew the numbers.
const roundOf = (m: ComplexMath) => (): void => {
  let s = (m.open(undefined, ctx) as OpenOutcome).state;
  for (let k = 0; k < 3; k++) s = (m.step(s, GAMBLE) as StepOutcome).state;
  m.close(s);
};

// rng=()=>0: base wins, every gamble succeeds -> a fixed 3-gamble round.
const luaOn = (await loadLuaMath(resolve(here, "../maths/gamble.lua"), { rng: () => 0 })) as ComplexMath;
const luaOff = (await loadLuaMath(resolve(here, "../maths/gamble.lua"), { rng: () => 0, timeoutMs: 0 })) as ComplexMath;
const wasm = (await loadWasmMath(resolve(here, "../maths/gamble.wasm"), { rng: () => 0 })) as ComplexMath;

const N = 100_000;
const a = bench(roundOf(luaOn), N);
const b = bench(roundOf(luaOff), N);
const c = bench(roundOf(wasm), N);

console.log(`twin-gamble - per full round = open + 3 gambles + close (${N.toLocaleString()} rounds x7, best rep)\n`);
console.log(`  lua  (watchdog on, default):  ${a.toFixed(2).padStart(7)} us`);
console.log(`  lua  (watchdog off):          ${b.toFixed(2).padStart(7)} us`);
console.log(`  wasm (zig):                   ${c.toFixed(2).padStart(7)} us`);
console.log(`\n  -> wasm is ${(a / c).toFixed(1)}x faster than Lua (default), ${(b / c).toFixed(1)}x with the watchdog off`);
