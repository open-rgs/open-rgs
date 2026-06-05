// The gamble-slot's headline property: a FAIR gamble is EV-neutral, so RTP
// equals the base slot's (~96%) under any policy - gambling only moves variance.
// Plus the play-flow graph captures the gamble ladder.

import { describe, expect, test } from "bun:test";
import { simulate, type StrategyFn } from "../../../packages/simulator/src/index.js";
import { defineGame } from "../../../packages/contract/src/index.js";
import { makeGambleSlot } from "../src/gamble-slot.js";
import { neverGamble, gambleOnce, gambleToTarget, alwaysGamble, gambleLabel } from "../src/strategy.js";
import type { SimulationReport } from "../../../packages/simulator/src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const run = async (strat: StrategyFn, spins = 200_000, flow = false): Promise<SimulationReport> => {
  const math = makeGambleSlot(mulberry32(999)); // same deals per policy
  const manifest = defineGame({
    id: "gamble-slot", declaredRtp: 0.96, defaultMode: "default",
    modes: { default: { math, stakeMultiplier: 1 } },
  });
  const [r] = await simulate(manifest, {
    spinsPerMode: spins, complexStrategy: strat, seed: 3,
    ...(flow ? { flow: { label: gambleLabel } } : {}),
  });
  return r!;
};

describe("gamble-slot: a fair gamble is RTP-invariant (pure variance)", () => {
  test("base slot RTP ~ 96%", async () => {
    const r = await run(neverGamble);
    expect(r.rtp.measured).toBeGreaterThan(0.945);
    expect(r.rtp.measured).toBeLessThan(0.975);
  });

  test("RTP barely moves across gamble policies, but variance explodes", async () => {
    const never = await run(neverGamble);
    const once = await run(gambleOnce);
    const t3 = await run(gambleToTarget(3));
    const all = await run(alwaysGamble);

    // EV-neutral gamble -> RTP stays ~ the base RTP under any policy.
    expect(Math.abs(once.rtp.measured - never.rtp.measured)).toBeLessThan(0.03);
    expect(Math.abs(t3.rtp.measured - never.rtp.measured)).toBeLessThan(0.05);
    expect(all.rtp.measured).toBeGreaterThan(0.85); // high variance -> looser band
    expect(all.rtp.measured).toBeLessThan(1.12);

    // ...while the gamble piles on variance and reach.
    expect(once.multiplier.stdDev).toBeGreaterThan(never.multiplier.stdDev);
    expect(t3.multiplier.stdDev).toBeGreaterThan(once.multiplier.stdDev);
    expect(all.multiplier.stdDev).toBeGreaterThan(t3.multiplier.stdDev);
    expect(all.multiplier.max).toBeGreaterThan(t3.multiplier.max);
  }, 30_000);

  test("play-flow graph captures the gamble ladder (gamble / collect / bust)", async () => {
    const r = await run(gambleToTarget(3), 50_000, true);
    expect(r.flow).toBeDefined();
    expect(r.flow!.edges.some((e) => e.action === "gamble")).toBe(true);
    expect(r.flow!.edges.some((e) => e.action === "collect")).toBe(true);
    expect(r.flow!.edges.some((e) => e.to === "■ loss")).toBe(true); // a bust
    expect(r.flow!.edges.some((e) => e.to === "■ win")).toBe(true); // a collect
  });
});
