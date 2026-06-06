// Drive one full COMPLEX round - open -> step -> step -> close - through BOTH the
// Lua twin and the Zig/WASM twin with the same RNG, and watch them stay in sync.
// Shows how the host threads the opaque `state` back into every call (and how
// each runtime encodes that state differently while the OUTCOMES stay identical).
//
//   bun examples/twin-gamble/src/round.ts
//
// (Human-readable demo; test/twin-gamble.test.ts is the CI proof across many
// seeds and policies.)

import { resolve } from "node:path";
import { loadWasmMath, loadLuaMath } from "../../../packages/core/src/index.js";
import type { ComplexMath, PlayerAction } from "../../../packages/contract/src/index.js";

const here = import.meta.dir;
const ctx = { mode: "default" } as const;
const GAMBLE: PlayerAction = { type: "gamble" };

// Scripted DEMO-ONLY RNG: base spin wins, then heads, heads (each < 0.5). We then
// COLLECT (close) instead of gambling a third time. Real outcomes use a CSPRNG.
const script = (): (() => number) => {
  const vals = [0.0, 0.0, 0.0]; // base -> double -> double; close draws nothing
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
};

async function playRound(m: ComplexMath, label: string): Promise<void> {
  console.log(`--- ${label} (${m.name}) ---`);
  const o = await m.open(undefined, ctx);
  console.log(`open        ops=${JSON.stringify(o.ops)}  awaiting=${o.awaiting?.type ?? "-"}  state=${JSON.stringify(o.state)}`);
  let state = o.state;
  // Strategy: gamble twice, then collect (close).
  for (let k = 1; k <= 2; k++) {
    const s = await m.step(state, GAMBLE);
    state = s.state;
    console.log(`gamble ${k}    ops=${JSON.stringify(s.ops)}  awaiting=${s.awaiting?.type ?? "-"}  state=${JSON.stringify(state)}`);
  }
  const c = await m.close(state); // collect = close (no further step)
  console.log(`close       multiplier=${c.multiplier}  type=${c.type}\n`);
}

console.log("twin-gamble - one round, two runtimes, same RNG (base win, double, double, collect)\n");
await playRound((await loadLuaMath(resolve(here, "../maths/gamble.lua"), { rng: script(), timeoutMs: 0 })) as ComplexMath, "Lua  ");
await playRound((await loadWasmMath(resolve(here, "../maths/gamble.wasm"), { rng: script() })) as ComplexMath, "Zig/WASM");
console.log("Same ops, same awaiting, same payout - only the opaque `state` encoding differs");
console.log("(Lua: a \"g,d,w\" string; Zig: an 8-byte blob base64'd by the host).");
