// H7 — the simulator now threads carry across spins (so a stateful game's
// RTP is measured correctly) and emits a pass/fail RTP verdict with a
// confidence interval, so it can actually CERTIFY RTP.

import { describe, expect, test } from "bun:test";
import type { GameManifest, SimpleMath } from "@open-rgs/contract";
import { simulate } from "../src/index.js";

function manifest(math: SimpleMath, declaredRtp: number, modeRtp = declaredRtp): GameManifest {
  return Object.freeze({
    id: "g", declaredRtp, defaultMode: "default",
    modes: { default: { math, stakeMultiplier: 1, declaredRtp: modeRtp } },
  }) as GameManifest;
}

// Pays 2x only when the previous round threaded carry "ready" — alternates
// loss/win. Without carry threading every prev is undefined → never pays.
const carryMath: SimpleMath = {
  kind: "simple", name: "carry", version: "1", rtp: 1,
  play(prev) {
    if (prev === "ready") return { multiplier: 2, ops: [], type: "win" };
    return { multiplier: 0, ops: [], type: "loss", carry: "ready" };
  },
};

const fixed = (m: number): SimpleMath => ({
  kind: "simple", name: "fixed", version: "1", rtp: m,
  play: () => ({ multiplier: m, ops: [], type: "x" }),
});

describe("simulator certification (H7)", () => {
  test("carry is threaded across spins (stateful RTP measured correctly)", async () => {
    const [r] = await simulate(manifest(carryMath, 1.0), { spinsPerMode: 2000 });
    // Alternating 0,2,0,2,… → RTP ~1.0. Without carry it would be 0.
    expect(r!.rtp.measured).toBeGreaterThan(0.9);
  });

  test("RTP verdict passes when measured matches declared", async () => {
    const [r] = await simulate(manifest(fixed(1.0), 1.0), { spinsPerMode: 1000 });
    expect(r!.rtp.verdict).toBe("pass");
    expect(r!.rtp.standardError).toBe(0); // constant multiplier
    expect(r!.rtp.ci95).toEqual([1.0, 1.0]);
  });

  test("RTP verdict fails when measured significantly differs from declared", async () => {
    // math pays 0.5 but the manifest claims 0.9 — a real mis-declaration.
    const [r] = await simulate(manifest(fixed(0.5), 0.9, 0.9), { spinsPerMode: 1000 });
    expect(r!.rtp.measured).toBeCloseTo(0.5, 6);
    expect(r!.rtp.verdict).toBe("fail");
  });

  test("a noisy math whose mean matches declared passes within the CI", async () => {
    // Bernoulli-ish via a seeded-by-index multiplier averaging ~0.8.
    let i = 0;
    const noisy: SimpleMath = {
      kind: "simple", name: "noisy", version: "1", rtp: 0.8,
      play: () => ({ multiplier: (i++ % 5 === 0) ? 4 : 0, ops: [], type: "x" }), // mean 0.8
    };
    const [r] = await simulate(manifest(noisy, 0.8, 0.8), { spinsPerMode: 5000 });
    expect(r!.rtp.measured).toBeCloseTo(0.8, 6);
    expect(r!.rtp.standardError).toBeGreaterThan(0);
    expect(r!.rtp.verdict).toBe("pass");
  });
});
