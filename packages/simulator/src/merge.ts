// Merge per-shard SimulationReports (same mode) into one, for sharded runs.
//
// A sharded run splits the spins across N independently-seeded processes
// (see cli.ts `--shards`). Each shard reports on its own slice; this merges
// the slices into a report statistically equivalent to one big run.
//
// EXACT (from per-shard sufficient statistics):
//   - measured RTP, standard error, 95% CI, verdict
//   - hit rate, outcome-type / next-mode counts
//   - multiplier mean, stdDev (pooled population variance), min, max
//   - counters, tag shares, RTP contributions, mark observation mean/stdDev
//   - deviations (recomputed from the merged series vs the math's `expected`)
//   - narrative
//
// APPROXIMATE (cannot be recovered exactly from per-shard percentiles
// without the raw samples): the distribution PERCENTILES (multiplier and
// observation p50..p99). We count-weight them and flag the merged report
// with `sharded.percentilesApproximate`. Min/mean/stdDev/max stay exact, so
// the cert-critical numbers are never approximate.

import type { MathExpectations } from "@open-rgs/contract";
import type { SimulationReport, DistributionStats } from "./report.js";
import { computeDeviations, narrate } from "./deviation.js";

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/** Union of keys across a list of records, first-seen order. */
function unionKeys(maps: ReadonlyArray<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of maps) for (const k of Object.keys(m)) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/** Sum a set of `Record<string, number>` over the union of their keys. */
function sumNumMaps(maps: ReadonlyArray<Record<string, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of maps) for (const [k, v] of Object.entries(m)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Exact pooled population mean + stdDev from per-part (n, mean, stdDev).
 *  Uses total Sx2 = sum n_i (sd_i^2 + mean_i^2); var = Sx2/N - mean^2. */
function pooled(parts: ReadonlyArray<{ n: number; mean: number; std: number }>): { mean: number; std: number } {
  const N = sum(parts.map(p => p.n));
  if (N === 0) return { mean: 0, std: 0 };
  const mean = sum(parts.map(p => p.n * p.mean)) / N;
  const sx2 = sum(parts.map(p => p.n * (p.std * p.std + p.mean * p.mean)));
  return { mean, std: Math.sqrt(Math.max(0, sx2 / N - mean * mean)) };
}

/** Count-weighted percentile blend (approximate; see file header). */
function blend(parts: ReadonlyArray<{ n: number; v: number }>): number {
  const N = sum(parts.map(p => p.n));
  return N === 0 ? 0 : sum(parts.map(p => p.n * p.v)) / N;
}

/** Merge N per-shard reports for the SAME mode into one. `expected` is the
 *  mode's `math.expected` (the parent has the manifest), used to recompute
 *  deviations exactly from the merged series. Single-element input is
 *  returned unchanged. */
export function mergeReports(reports: readonly SimulationReport[], expected?: MathExpectations): SimulationReport {
  if (reports.length === 0) throw new Error("mergeReports: no reports to merge");
  const base = reports[0]!;
  if (reports.length === 1) return base;

  const spins = sum(reports.map(r => r.spins));
  const totalBet = sum(reports.map(r => r.bet.totalUnits));
  const totalWin = sum(reports.map(r => r.win.totalUnits));
  const measured = totalBet === 0 ? 0 : totalWin / totalBet;
  const declared = base.rtp.declared;
  const betPerSpin = base.bet.unitsPerSpin;

  const mult = pooled(reports.map(r => ({ n: r.spins, mean: r.multiplier.mean, std: r.multiplier.stdDev })));
  const multiplier: DistributionStats = {
    min: Math.min(...reports.map(r => r.multiplier.min)),
    max: Math.max(...reports.map(r => r.multiplier.max)),
    mean: mult.mean,
    stdDev: mult.std,
    p50: blend(reports.map(r => ({ n: r.spins, v: r.multiplier.p50 }))),
    p90: blend(reports.map(r => ({ n: r.spins, v: r.multiplier.p90 }))),
    p95: blend(reports.map(r => ({ n: r.spins, v: r.multiplier.p95 }))),
    p99: blend(reports.map(r => ({ n: r.spins, v: r.multiplier.p99 }))),
  };

  const standardError = spins > 0 ? mult.std / Math.sqrt(spins) : 0;
  const rtpDelta = Math.abs(declared - measured);
  const verdict: "pass" | "warn" | "fail" =
    standardError === 0 ? (rtpDelta < 1e-9 ? "pass" : "fail") :
    rtpDelta <= 1.96 * standardError ? "pass" :
    rtpDelta <= 2.576 * standardError ? "warn" : "fail";

  const hitRate = spins === 0 ? 0 : sum(reports.map(r => r.hitRate * r.spins)) / spins;
  const outcomeTypes = sumNumMaps(reports.map(r => r.outcomeTypes));
  const nextModeRoutes = sumNumMaps(reports.map(r => r.nextModeRoutes));

  const counterTotals = sumNumMaps(reports.map(r => Object.fromEntries(Object.entries(r.counters).map(([k, c]) => [k, c.total]))));
  const counters: SimulationReport["counters"] = {};
  for (const [k, total] of Object.entries(counterTotals)) counters[k] = { total, perSpin: spins === 0 ? 0 : total / spins };

  const observations: SimulationReport["observations"] = {};
  for (const name of unionKeys(reports.map(r => r.observations))) {
    const parts = reports.map(r => r.observations[name]).filter(Boolean) as (DistributionStats & { count: number })[];
    const ms = pooled(parts.map(o => ({ n: o.count, mean: o.mean, std: o.stdDev })));
    observations[name] = {
      count: sum(parts.map(o => o.count)),
      min: Math.min(...parts.map(o => o.min)),
      max: Math.max(...parts.map(o => o.max)),
      mean: ms.mean,
      stdDev: ms.std,
      p50: blend(parts.map(o => ({ n: o.count, v: o.p50 }))),
      p90: blend(parts.map(o => ({ n: o.count, v: o.p90 }))),
      p95: blend(parts.map(o => ({ n: o.count, v: o.p95 }))),
      p99: blend(parts.map(o => ({ n: o.count, v: o.p99 }))),
    };
  }

  const tagSpinTotals = sumNumMaps(reports.map(r => Object.fromEntries(Object.entries(r.tagShares).map(([k, t]) => [k, t.spins]))));
  const tagShares: SimulationReport["tagShares"] = {};
  for (const [k, sp] of Object.entries(tagSpinTotals)) tagShares[k] = { spins: sp, share: spins === 0 ? 0 : sp / spins };

  const ctbSums = sumNumMaps(reports.map(r => Object.fromEntries(Object.entries(r.rtpContributions).map(([k, c]) => [k, c.sumMultiplier]))));
  const rtpContributions: SimulationReport["rtpContributions"] = {};
  for (const [k, sm] of Object.entries(ctbSums)) rtpContributions[k] = { sumMultiplier: sm, rtpShare: totalBet === 0 ? 0 : (sm * betPerSpin) / totalBet };

  const rates: Record<string, number> = {};
  for (const [k, c] of Object.entries(counters)) rates[k] = c.perSpin;
  const deviations = computeDeviations(expected, {
    hitRate,
    rates,
    rtpContributions: Object.fromEntries(Object.entries(rtpContributions).map(([k, v]) => [k, v.rtpShare])),
    tagShares: Object.fromEntries(Object.entries(tagShares).map(([k, v]) => [k, v.share])),
  });

  const topContributions = Object.entries(rtpContributions)
    .map(([name, c]) => ({ name, rtpShare: c.rtpShare }))
    .sort((a, b) => b.rtpShare - a.rtpShare);
  const narrative = narrate(
    base.game.id, base.mode.id,
    { measured, declared, delta: measured - declared },
    hitRate, deviations, topContributions,
  );

  return {
    game: base.game,
    mode: base.mode,
    math: base.math,
    spins,
    bet: { unitsPerSpin: betPerSpin, totalUnits: totalBet },
    win: { totalUnits: totalWin, maxMultiplier: Math.max(...reports.map(r => r.win.maxMultiplier)) },
    rtp: { measured, declared, delta: measured - declared, standardError, ci95: [measured - 1.96 * standardError, measured + 1.96 * standardError], verdict },
    hitRate,
    multiplier,
    outcomeTypes,
    nextModeRoutes,
    counters,
    observations,
    tagShares,
    rtpContributions,
    deviations,
    narrative,
    ...(base.complex
      ? { complex: { averageStepsPerRound: spins === 0 ? 0 : sum(reports.map(r => (r.complex?.averageStepsPerRound ?? 0) * r.spins)) / spins } }
      : {}),
    elapsedMs: Math.max(...reports.map(r => r.elapsedMs)),
    sharded: { shards: reports.length, percentilesApproximate: true },
  };
}
