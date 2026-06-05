// SEE how basic strategy actually played: a Markov chain over coarse player-
// state buckets, emitted as a Mermaid chart (paste into any Mermaid viewer, or
// it renders inline on GitHub) + a transition table.
//
//   bun examples/blackjack/src/flow.ts

import { simulate, flowToMermaid, flowToMarkovTable } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeBlackjack } from "./blackjack.js";
import { basicStrategy, bucketLabel } from "./strategy.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const math = makeBlackjack(mulberry32(12345));
const manifest = defineGame({
  id: "blackjack", declaredRtp: 0.99, defaultMode: "default",
  modes: { default: { math, stakeMultiplier: 1 } },
});
const [r] = await simulate(manifest, { spinsPerMode: 300_000, complexStrategy: basicStrategy, flow: { label: bucketLabel } });

console.log("How basic strategy played 300k hands (paste into a Mermaid viewer):\n");
console.log("```mermaid");
console.log(flowToMermaid(r!.flow!));
console.log("```\n");
console.log(flowToMarkovTable(r!.flow!));
