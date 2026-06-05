// The headline property: a FAIR gamble is EV-neutral, so the gamble-slot's RTP
// equals the base slot's (~96%) under EVERY policy - gambling only moves
// variance. Same game, five policies: RTP barely budges, stdDev explodes.
//
//   bun examples/gamble-slot/src/study.ts

import { simulate, type StrategyFn } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeGambleSlot } from "./gamble-slot.js";
import { neverGamble, gambleOnce, gambleToTarget, alwaysGamble } from "./strategy.js";

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
  ["never gamble (base slot)", neverGamble],
  ["gamble once", gambleOnce],
  ["gamble to 3x doubles", gambleToTarget(3)],
  ["always gamble (to bust/cap)", alwaysGamble],
];

console.log(`gamble-slot: same game, different gamble policy  (${SPINS.toLocaleString()} rounds each)\n`);
console.log("  policy                          RTP       hit-rate   mult stddev   max mult");
for (const [name, strat] of policies) {
  const math = makeGambleSlot(mulberry32(12345));
  const manifest = defineGame({
    id: "gamble-slot", declaredRtp: 0.96, defaultMode: "default",
    modes: { default: { math, stakeMultiplier: 1 } },
  });
  const [r] = await simulate(manifest, { spinsPerMode: SPINS, complexStrategy: strat, seed: 7 });
  console.log(
    `  ${name.padEnd(30)}  ${(r!.rtp.measured * 100).toFixed(2)}%     ${(r!.hitRate * 100).toFixed(1).padStart(5)}%      ${r!.multiplier.stdDev.toFixed(2).padStart(7)}   ${r!.multiplier.max.toFixed(0).padStart(6)}x`,
  );
}
console.log("\nRTP is ~96% no matter how you gamble - a fair gamble is pure variance, not edge.");
console.log("That's the testable invariant. (cash-ladder's UNFAIR gamble, by contrast, bleeds RTP per rung.)");
