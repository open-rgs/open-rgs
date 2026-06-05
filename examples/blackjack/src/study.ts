// RTP-by-policy study for blackjack: the same game, simulated under five
// different player policies. A game with options has no single RTP - the number
// you certify depends entirely on the strategy. Optimal (basic strategy) is
// near-fair; naive policies bleed.
//
//   bun examples/blackjack/src/study.ts

import { simulate, type StrategyFn } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeBlackjack } from "./blackjack.js";
import { basicStrategy, mimicDealer, alwaysStand, alwaysHit, randomPlay } from "./strategy.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPINS = 1_000_000;
const policies: Array<[string, StrategyFn]> = [
  ["basic strategy (optimal-ish)", basicStrategy],
  ["mimic dealer (hit < 17)", mimicDealer],
  ["random", randomPlay],
  ["always stand", alwaysStand],
  ["always hit", alwaysHit],
];

console.log(`blackjack RTP by player policy  (${SPINS.toLocaleString()} hands each)\n`);
console.log("  policy                          RTP       hands/s");
for (const [name, strat] of policies) {
  const math = makeBlackjack(mulberry32(12345)); // same starting deals per policy
  const manifest = defineGame({
    id: "blackjack", declaredRtp: 0.99, defaultMode: "default",
    modes: { default: { math, stakeMultiplier: 1 } },
  });
  const t0 = performance.now();
  const [r] = await simulate(manifest, { spinsPerMode: SPINS, complexStrategy: strat, seed: 7 });
  const dt = performance.now() - t0;
  const hps = Math.round((SPINS / dt) * 1000).toLocaleString();
  console.log(`  ${name.padEnd(30)}  ${(r!.rtp.measured * 100).toFixed(2)}%   ${hps.padStart(9)}`);
}
console.log("\nSame game, a huge RTP spread - ~98% (optimal) down to ~11% (always hit).");
console.log("'What's the RTP?' is only answerable as 'under which strategy?' - optimal is the ceiling.");
