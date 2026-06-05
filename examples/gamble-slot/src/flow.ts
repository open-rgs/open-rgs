// SEE the gamble ladder: a Markov chain of how a "gamble to 3x doubles" policy
// played out, as a Mermaid chart + transition table.
//
//   bun examples/gamble-slot/src/flow.ts

import { simulate, flowToMermaid, flowToMarkovTable } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeGambleSlot } from "./gamble-slot.js";
import { gambleToTarget, gambleLabel } from "./strategy.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const math = makeGambleSlot(mulberry32(12345));
const manifest = defineGame({
  id: "gamble-slot", declaredRtp: 0.96, defaultMode: "default",
  modes: { default: { math, stakeMultiplier: 1 } },
});
const [r] = await simulate(manifest, { spinsPerMode: 300_000, complexStrategy: gambleToTarget(3), flow: { label: gambleLabel } });

console.log("How 'gamble to 3x doubles' played 300k rounds:\n");
console.log("```mermaid");
console.log(flowToMermaid(r!.flow!));
console.log("```\n");
console.log(flowToMarkovTable(r!.flow!));
