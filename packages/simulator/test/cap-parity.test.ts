// The simulator's cap must behave EXACTLY as the orchestrator's, because the
// whole point of measuring a capped RTP is that it is the RTP the server pays.
// The simulator has no core dependency by design, so the rule is implemented
// twice - and pinned here, against the real thing.

import { describe, expect, test } from "bun:test";
import { applyMaxWinCap } from "@open-rgs/core";
import { applyCap, simulate } from "../src/index.js";
import { defineGame, type SimpleMath } from "@open-rgs/contract";

describe("cap parity with the orchestrator", () => {
  const cases: Array<[number, number | undefined]> = [
    [0, 5000], [1, 5000], [4999.9, 5000], [5000, 5000], [5000.1, 5000], [1e9, 5000],
    [0.5, undefined], [12345, undefined],
    [-1, 5000], [-0, 5000],
  ];

  for (const [multiplier, cap] of cases) {
    test(`multiplier ${multiplier} under cap ${cap ?? "none"}`, () => {
      const engine = applyMaxWinCap({ multiplier, ops: [], type: "spin" }, 1, cap).multiplier;
      expect(applyCap(multiplier, cap)).toBe(engine);
    });
  }

  test("a non-finite multiplier fails the round in the engine and pays nothing here", () => {
    // The engine throws rather than paying (the NaN <= cap trap). The simulator
    // cannot throw away a whole run for one bad spin, so it counts zero - which
    // is the same money.
    expect(() => applyMaxWinCap({ multiplier: NaN, ops: [], type: "spin" }, 1, 5000)).toThrow();
    expect(applyCap(NaN, 5000)).toBe(0);
    expect(applyCap(Infinity, 5000)).toBe(0);
  });
});

describe("measured RTP is the RTP the server would pay", () => {
  // 1 spin in 1000 pays 100_000x; the manifest caps at 5_000x.
  // Uncapped RTP = 100. Capped RTP = 5.
  let n = 0;
  const spiky: SimpleMath = {
    kind: "simple", name: "spiky", version: "1", rtp: 5,
    play: () => (++n % 1000 === 0
      ? { multiplier: 100_000, ops: [], type: "win" }
      : { multiplier: 0, ops: [], type: "loss" }),
  };

  test("the cap is applied, and its cost is reported", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap", declaredRtp: 1, defaultMode: "default", maxWinMultiplier: 5_000,
      modes: { default: { math: spiky, stakeMultiplier: 1 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(5, 6);
    expect(r!.rtp.measuredUncapped).toBeCloseTo(100, 6);
    expect(r!.rtp.maxWinMultiplier).toBe(5_000);
    expect(r!.rtp.capped.rounds).toBe(10);
    expect(r!.rtp.capped.rtpRemoved).toBeCloseTo(95, 6);
    // and the distribution the report prints is the capped one
    expect(r!.win.maxMultiplier).toBe(5_000);
  });

  test("a per-mode cap overrides the game-wide one, as it does in the orchestrator", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap2", declaredRtp: 1, defaultMode: "default", maxWinMultiplier: 5_000,
      modes: { default: { math: spiky, stakeMultiplier: 1, maxWinMultiplier: 1_000 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(1, 6);
    expect(r!.rtp.maxWinMultiplier).toBe(1_000);
  });

  test("no cap configured leaves the measurement untouched", async () => {
    n = 0;
    const manifest = defineGame({
      id: "cap3", declaredRtp: 1, defaultMode: "default",
      modes: { default: { math: spiky, stakeMultiplier: 1 } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 10_000 });
    expect(r!.rtp.measured).toBeCloseTo(100, 6);
    expect(r!.rtp.capped.rounds).toBe(0);
    expect(r!.rtp.maxWinMultiplier).toBeNull();
  });
});
