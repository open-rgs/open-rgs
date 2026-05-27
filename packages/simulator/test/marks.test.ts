// Smoke tests for marks + deviation + html serialization.

import { describe, expect, test } from "bun:test";
import type { GameManifest, SimpleMath, MarkCollector } from "@open-rgs/contract";
import { simulate, htmlReportSet, mulberry32 } from "../src/index.js";

// A tiny SimpleMath that uses a fake collector. We need to plumb the
// collector ourselves because there's no Lua VM in this test.
function math(opts: {
  multiplier: number;
  marks: MarkCollector;
  mark?: (m: MarkCollector) => void;
}): SimpleMath {
  return {
    kind: "simple",
    name: "marked",
    version: "0.0.1",
    rtp: opts.multiplier,
    marks: opts.marks,
    expected: {
      hitRate: { target: opts.multiplier > 0 ? 1.0 : 0.0, tolerance: 0.01 },
      rate: { spin: { target: 1.0, tolerance: 0.0 } },
      rtpContribution: {
        bucket: { target: opts.multiplier, tolerance: 0.01 },
      },
      tagShare: { tagged: { target: 1.0, tolerance: 0.0 } },
    },
    play() {
      opts.marks.count("spin");
      opts.marks.tag("tagged");
      opts.marks.contribute("bucket", opts.multiplier);
      opts.marks.observe("multiplier_per_spin", opts.multiplier);
      opts.mark?.(opts.marks);
      return {
        multiplier: opts.multiplier,
        ops: [],
        type: opts.multiplier > 0 ? "win" : "loss",
      };
    },
  };
}

// In-test collector matching the contract surface. Mirrors core's
// createMarkCollector behaviour without dragging core in.
function makeCollector(): MarkCollector {
  const counts: Record<string, number> = {};
  const observations: Record<string, number[]> = {};
  const tagSpins: Record<string, number> = {};
  const contributions: Record<string, number> = {};
  let spinTags: Set<string> = new Set();
  let spinsCompleted = 0;
  return {
    count(n) { counts[n] = (counts[n] ?? 0) + 1; },
    observe(n, v) { (observations[n] ??= []).push(v); },
    tag(n) { spinTags.add(n); },
    contribute(n, m) { contributions[n] = (contributions[n] ?? 0) + m; },
    beginSpin() { /* nothing */ },
    endSpin() {
      for (const t of spinTags) tagSpins[t] = (tagSpins[t] ?? 0) + 1;
      spinTags = new Set();
      spinsCompleted += 1;
    },
    snapshot() {
      return {
        counts: { ...counts },
        observations: Object.fromEntries(Object.entries(observations).map(([k, v]) => [k, [...v]])),
        tagSpins: { ...tagSpins },
        contributions: { ...contributions },
        spinsCompleted,
      };
    },
  };
}

describe("@open-rgs/simulator marks + deviation", () => {
  test("counters and contributions flow into the report", async () => {
    const collector = makeCollector();
    const m = math({ multiplier: 2, marks: collector });
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 2.0, defaultMode: "default",
      modes: { default: { math: m, stakeMultiplier: 1, declaredRtp: 2.0 } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 500 });

    expect(r!.counters["spin"]).toEqual({ total: 500, perSpin: 1 });
    expect(r!.tagShares["tagged"]).toEqual({ spins: 500, share: 1 });
    expect(r!.rtpContributions["bucket"]?.sumMultiplier).toBe(1000);  // 500 * 2
    expect(r!.rtpContributions["bucket"]?.rtpShare).toBe(2.0);        // sumMult * bet / totalBet
    expect(r!.observations["multiplier_per_spin"]?.mean).toBe(2);
    expect(r!.observations["multiplier_per_spin"]?.count).toBe(500);
  });

  test("deviations are computed against expected{} and flagged", async () => {
    const collector = makeCollector();
    const m = math({ multiplier: 2, marks: collector });
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 2.0, defaultMode: "default",
      modes: { default: { math: m, stakeMultiplier: 1 } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 100 });

    // All four targets should be "ok" since math hits them exactly.
    const statuses = r!.deviations.map(d => d.status);
    expect(statuses.length).toBe(4);
    expect(statuses.every(s => s === "ok")).toBe(true);

    const hitDev = r!.deviations.find(d => d.key === "hit_rate");
    expect(hitDev?.measured).toBe(1.0);
    expect(hitDev?.target).toBe(1.0);

    const contribDev = r!.deviations.find(d => d.key === "rtp_contribution.bucket");
    expect(contribDev?.measured).toBe(2.0);
    expect(contribDev?.status).toBe("ok");
  });

  test("narrative is a non-empty diagnosis string", async () => {
    const collector = makeCollector();
    const m = math({ multiplier: 1, marks: collector });
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 1.0, defaultMode: "default",
      modes: { default: { math: m, stakeMultiplier: 1, declaredRtp: 1.0 } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 100 });
    expect(r!.narrative).toContain("g/default");
    expect(r!.narrative).toContain("RTP");
    expect(r!.narrative).toContain("targets");
  });

  test("htmlReportSet emits a self-contained HTML document", async () => {
    const collector = makeCollector();
    const m = math({ multiplier: 1, marks: collector });
    const manifest: GameManifest = Object.freeze({
      id: "g", declaredRtp: 1.0, defaultMode: "default",
      modes: { default: { math: m, stakeMultiplier: 1, label: "Base" } },
    });

    const [r] = await simulate(manifest, { spinsPerMode: 100 });
    const html = htmlReportSet([r!], {
      generatedAt: "2025-01-01T00:00:00Z",
      generator: "test-runner",
    });

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Simulation");
    expect(html).toContain("hello-spin".replace("hello-spin", "g")); // just the id is there
    expect(html).toContain("test-runner");
    expect(html).toContain("§");                    // small-caps headings
    expect(html).toContain("Targets vs measured");  // dev section rendered
    expect(html).toContain("--accent");             // CSS vars inline
    expect(html).toContain('data-theme="light"');   // initial theme attr OR default light vars
    expect(html.length).toBeGreaterThan(2000);
  });

  test("mulberry32 stays deterministic across runs", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });
});
