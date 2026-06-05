// Blackjack RTP is policy-relative: basic strategy is near-fair and the ceiling;
// naive policies bleed. Also a sanity check on the hand evaluator.

import { describe, expect, test } from "bun:test";
import { simulate, type StrategyFn } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeBlackjack, handTotal } from "../src/blackjack.js";
import { basicStrategy, mimicDealer, alwaysHit, bucketLabel } from "../src/strategy.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rtpUnder = async (strat: StrategyFn): Promise<number> => {
  const math = makeBlackjack(mulberry32(999)); // same deals per policy
  const manifest = defineGame({
    id: "blackjack", declaredRtp: 0.99, defaultMode: "default",
    modes: { default: { math, stakeMultiplier: 1 } },
  });
  const [r] = await simulate(manifest, { spinsPerMode: 300_000, complexStrategy: strat, seed: 3 });
  return r!.rtp.measured;
};

describe("blackjack: RTP is policy-relative", () => {
  test("hand evaluator handles soft aces", () => {
    expect(handTotal([1, 6])).toEqual({ total: 17, soft: true }); // A,6
    expect(handTotal([1, 6, 10])).toEqual({ total: 17, soft: false }); // A counted as 1
    expect(handTotal([13, 13, 2])).toEqual({ total: 22, soft: false }); // K,K,2 bust
  });

  test("basic strategy is near-fair and beats naive play", async () => {
    const basic = await rtpUnder(basicStrategy);
    const mimic = await rtpUnder(mimicDealer);
    const hit = await rtpUnder(alwaysHit);
    expect(basic).toBeGreaterThan(0.96); // hit/stand basic strategy ~97.7%
    expect(basic).toBeLessThanOrEqual(1.0); // a real house edge -> no player advantage
    expect(basic).toBeGreaterThan(mimic); // optimal beats mimic-the-dealer
    expect(mimic).toBeGreaterThan(0.9); // mimic ~94%
    expect(hit).toBeLessThan(0.5); // always-hit busts -> bleeds
  }, 30_000);

  test("play-flow graph captures the decision buckets", async () => {
    const math = makeBlackjack(mulberry32(42));
    const manifest = defineGame({
      id: "blackjack", declaredRtp: 0.99, defaultMode: "default",
      modes: { default: { math, stakeMultiplier: 1 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 30_000, complexStrategy: basicStrategy, flow: { label: bucketLabel } });
    expect(r!.flow).toBeDefined();
    expect(r!.flow!.edges.some((e) => e.from.includes("stiff"))).toBe(true); // hard 12-16
    expect(r!.flow!.edges.some((e) => e.to.startsWith("■"))).toBe(true); // reaches an outcome
  }, 30_000);
});
