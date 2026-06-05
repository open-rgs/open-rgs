// Sharded simulation: the merge math must be EXACT for the cert-critical
// numbers, and the CLI must FAIL CLOSED when a manifest can't be re-seeded
// per shard (which would duplicate the RNG stream).

import { describe, expect, test, afterAll } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeReports } from "../src/merge.js";
import { mean, stdDev, percentileSorted } from "../src/stats.js";
import type { SimulationReport } from "../src/report.js";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
const FACTORY = resolve(import.meta.dir, "fixtures/shard-factory.ts");
const STATIC = resolve(import.meta.dir, "fixtures/shard-static.ts");

const tmps: string[] = [];
afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

/** Build a SimulationReport from raw multiplier samples, mirroring how
 *  simulate() computes each field, so the merge can be checked against
 *  ground truth over the concatenation. */
function makeReport(samples: number[], betPerSpin = 1): SimulationReport {
  const spins = samples.length;
  const sorted = [...samples].sort((a, b) => a - b);
  const mu = mean(samples);
  const totalWin = samples.reduce((a, m) => a + m * betPerSpin, 0);
  const totalBet = spins * betPerSpin;
  const outcomeTypes: Record<string, number> = {};
  for (const m of samples) { const t = m > 0 ? "win" : "loss"; outcomeTypes[t] = (outcomeTypes[t] ?? 0) + 1; }
  return {
    game: { id: "g", declaredRtp: 0.5, defaultMode: "default" },
    mode: { id: "default", stakeMultiplier: 1, internal: false },
    math: { name: "m", version: "1", declaredRtp: 0.5, kind: "simple" },
    spins,
    bet: { unitsPerSpin: betPerSpin, totalUnits: totalBet },
    win: { totalUnits: totalWin, maxMultiplier: sorted[sorted.length - 1] ?? 0 },
    rtp: { measured: totalBet ? totalWin / totalBet : 0, declared: 0.5, delta: 0, standardError: 0, ci95: [0, 0], verdict: "pass" },
    hitRate: spins ? samples.filter(m => m > 0).length / spins : 0,
    multiplier: {
      min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, mean: mu, stdDev: stdDev(samples, mu),
      p50: percentileSorted(sorted, 50), p90: percentileSorted(sorted, 90), p95: percentileSorted(sorted, 95), p99: percentileSorted(sorted, 99),
    },
    outcomeTypes, nextModeRoutes: {},
    counters: {}, observations: {}, tagShares: {}, rtpContributions: {},
    deviations: [], narrative: "", elapsedMs: 1,
  };
}

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("mergeReports (exact merge math)", () => {
  test("mean / stdDev / min / max / rtp / hitRate equal the concatenation", () => {
    const A = [0, 1, 2, 0, 3, 0, 5, 1];
    const B = [1, 1, 0, 4, 0, 0, 2];
    const all = [...A, ...B];
    const m = mergeReports([makeReport(A), makeReport(B)]);

    expect(m.spins).toBe(all.length);
    close(m.multiplier.mean, mean(all));
    close(m.multiplier.stdDev, stdDev(all));          // pooled variance, exact
    expect(m.multiplier.min).toBe(Math.min(...all));
    expect(m.multiplier.max).toBe(Math.max(...all));
    close(m.rtp.measured, mean(all));                 // betPerSpin = 1
    close(m.hitRate, all.filter(x => x > 0).length / all.length);
    expect(m.win.maxMultiplier).toBe(Math.max(...all));
    expect(m.sharded?.shards).toBe(2);
    expect(m.sharded?.percentilesApproximate).toBe(true);
  });

  test("outcome-type counts are additive across shards", () => {
    const A = [0, 1, 0];      // 2 loss, 1 win
    const B = [1, 1, 0, 2];   // 1 loss, 3 win
    const m = mergeReports([makeReport(A), makeReport(B)]);
    expect(m.outcomeTypes["win"]).toBe(4);
    expect(m.outcomeTypes["loss"]).toBe(3);
  });

  test("single report passes through unchanged", () => {
    const A = makeReport([1, 0, 2]);
    expect(mergeReports([A])).toBe(A);
  });
});

describe("shard CLI", () => {
  test("happy path: factory manifest shards and merges", async () => {
    const out = await mkdtemp(join(tmpdir(), "rgs-shard-")); tmps.push(out);
    const proc = Bun.spawn({
      cmd: ["bun", CLI, FACTORY, "--spins", "400", "--shards", "2", "--seed", "5", "--format", "json", "--out", out, "--quiet", "true"],
      stdout: "pipe", stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(0);
    const json = JSON.parse(await readFile(join(out, "shardfix-seed5-spins400-shards2.json"), "utf-8"));
    const r = json.reports[0] as SimulationReport;
    expect(r.spins).toBe(400);                    // 2 shards x 200
    expect(r.sharded?.shards).toBe(2);
    expect(r.rtp.measured).toBeGreaterThan(0.2);  // ~0.5 EV, loose band
    expect(r.rtp.measured).toBeLessThan(0.8);
    if (code !== 0) console.error(err);
  }, 30_000);

  test("fail closed: refuses to shard a static (non-factory) manifest", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", CLI, STATIC, "--spins", "100", "--shards", "2", "--quiet", "true"],
      stdout: "pipe", stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(code).toBe(2);
    expect(err).toContain("cannot shard a static manifest");
  }, 30_000);
});
