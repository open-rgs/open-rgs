// Drive a full complex round of the cash-ladder Zig kernel: open -> climb* ->
// close. Watch how the host threads the kernel's serialized `state` (an opaque
// base64 string) back into every call.
//
//   bun examples/cash-ladder/src/round.ts

import { resolve } from "node:path";
import { loadWasmMath } from "../../../packages/core/src/index.js";
import type { ComplexMath, PlayerAction } from "../../../packages/contract/src/index.js";

const wasm = resolve(import.meta.dir, "../maths/play.wasm");

// Tiny seeded PRNG so the demo is reproducible. DEV/DEMO ONLY - production
// outcome RNG must be a CSPRNG; loadWasmMath defaults to cryptoRng.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const math = (await loadWasmMath(wasm, { rng: mulberry32(2) })) as ComplexMath;
console.log(`loaded ${math.name}@${math.version}  (kind=${math.kind}, rtp ${math.rtp})\n`);

const o = await math.open(undefined, { mode: "default" });
console.log("open   ->", JSON.stringify({ state: o.state, ops: o.ops, awaiting: o.awaiting }));

// Strategy: climb up to 3 rungs, then cash out (stop early if we bust).
let state = o.state;
const climb: PlayerAction = { type: "climb" };
for (let k = 1; k <= 3; k++) {
  const s = await math.step(state, climb);
  state = s.state;
  console.log(`climb ${k} ->`, JSON.stringify({ ops: s.ops, awaiting: s.awaiting ?? null, state }));
  if (!s.awaiting) break; // busted (or reached the top) -> must close
}

const c = await math.close(state);
console.log("\nclose  ->", JSON.stringify({ multiplier: c.multiplier, type: c.type }));
