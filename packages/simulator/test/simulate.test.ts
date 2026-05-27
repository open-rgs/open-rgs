// Smoke test: simulate a tiny synthetic manifest and verify the report
// numbers add up. No lua/wasmoon involved — we hand-roll a SimpleMath
// so the test is pure TS.

import { describe, expect, test } from "bun:test";
import type { GameManifest, SimpleMath } from "@open-rgs/contract";
import { simulate, mdReport, mdReportSet, mulberry32 } from "../src/index.js";

function fixedMath(name: string, multiplier: number, type = "fixed"): SimpleMath {
  return {
    kind: "simple",
    name,
    version: "0.0.1",
    rtp: multiplier,
    play() {
      return { multiplier, ops: [], type };
    },
  };
}

function bernoulliMath(p: number, win: number, seed: number): SimpleMath {
  // Wins `win` with probability p, else 0. Uses an injected mulberry32.
  const r = mulberry32(seed);
  return {
    kind: "simple",
    name: "bernoulli",
    version: "0.0.1",
    rtp: p * win,
    play() {
      const v = r();
      const multiplier = v < p ? win : 0;
      return { multiplier, ops: [], type: multiplier > 0 ? "win" : "loss" };
    },
  };
}

describe("@open-rgs/simulator", () => {
  test("fixed-multiplier math measures exact RTP", async () => {
    const math = fixedMath("always-1x", 1.0);
    const manifest: GameManifest = Object.freeze({
      id: "tiny", declaredRtp: 1.0, defaultMode: "default",
      modes: { default: { math, stakeMultiplier: 1, label: "Base", declaredRtp: 1.0 } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 1000 });

    expect(r!.spins).toBe(1000);
    expect(r!.rtp.measured).toBe(1.0);
    expect(r!.rtp.declared).toBe(1.0);
    expect(r!.rtp.delta).toBe(0);
    expect(r!.hitRate).toBe(1.0);
    expect(r!.multiplier.min).toBe(1.0);
    expect(r!.multiplier.max).toBe(1.0);
    expect(r!.outcomeTypes["fixed"]).toBe(1000);
    expect(r!.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("seeded Bernoulli math measures RTP within a tolerance", async () => {
    // p=0.4, win=2 → expected RTP 0.8, hit rate 0.4
    const math = bernoulliMath(0.4, 2.0, 42);
    const manifest: GameManifest = Object.freeze({
      id: "bern", declaredRtp: 0.8, defaultMode: "default",
      modes: { default: { math, stakeMultiplier: 1, declaredRtp: 0.8 } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 20_000 });

    // Loose tolerance — 20k spins, Bernoulli, expect ~±2% off declared.
    expect(Math.abs(r!.rtp.measured - 0.8)).toBeLessThan(0.03);
    expect(Math.abs(r!.hitRate - 0.4)).toBeLessThan(0.02);
    expect(r!.outcomeTypes["win"]).toBeGreaterThan(7500);
    expect(r!.outcomeTypes["loss"]).toBeGreaterThan(11000);
  });

  test("multiple modes → one report each, in declared order", async () => {
    const a = fixedMath("a", 0.5);
    const b = fixedMath("b", 1.5);
    const manifest: GameManifest = Object.freeze({
      id: "two", declaredRtp: 1.0, defaultMode: "alpha",
      modes: Object.freeze({
        alpha: { math: a, stakeMultiplier: 1, declaredRtp: 0.5 },
        beta:  { math: b, stakeMultiplier: 2, declaredRtp: 1.5 },
      }),
    });

    const reports = await simulate(manifest, { spinsPerMode: 100 });

    expect(reports.length).toBe(2);
    expect(reports[0]!.mode.id).toBe("alpha");
    expect(reports[1]!.mode.id).toBe("beta");
    expect(reports[1]!.bet.unitsPerSpin).toBe(2); // 1 * stakeMultiplier(2)
    expect(reports[1]!.rtp.measured).toBe(1.5);
  });

  test("includeInternal=false skips internal modes", async () => {
    const a = fixedMath("a", 1.0);
    const fs = fixedMath("fs", 2.0);
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 1.0, defaultMode: "default",
      modes: Object.freeze({
        default:     { math: a,  stakeMultiplier: 1 },
        "free-spins": { math: fs, stakeMultiplier: 0, internal: true },
      }),
    });

    const visible  = await simulate(manifest, { spinsPerMode: 50, includeInternal: false });
    const all      = await simulate(manifest, { spinsPerMode: 50, includeInternal: true });

    expect(visible.length).toBe(1);
    expect(visible[0]!.mode.id).toBe("default");
    expect(all.length).toBe(2);
  });

  test("mdReport renders a non-empty markdown block", async () => {
    const math = fixedMath("a", 1.0);
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 1.0, defaultMode: "default",
      modes: { default: { math, stakeMultiplier: 1, label: "Base" } },
    });
    const [r] = await simulate(manifest, { spinsPerMode: 100 });
    const md = mdReport(r!);
    expect(md).toContain("# Simulation");
    expect(md).toContain("Measured RTP");
    expect(md).toContain("Multiplier distribution");
  });

  test("mdReportSet includes a summary table", async () => {
    const a = fixedMath("a", 0.5);
    const b = fixedMath("b", 1.5);
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 1.0, defaultMode: "alpha",
      modes: Object.freeze({
        alpha: { math: a, stakeMultiplier: 1 },
        beta:  { math: b, stakeMultiplier: 1 },
      }),
    });
    const reports = await simulate(manifest, { spinsPerMode: 100 });
    const md = mdReportSet(reports);
    expect(md).toContain("# Simulation report");
    expect(md).toContain("## Summary");
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
  });
});
