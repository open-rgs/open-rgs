// SimulationReport shape + markdown renderer. Keep this file readable
// — the markdown output is what most users will look at; the typed
// object is what an LLM eats.

import type { TargetDeviation } from "./deviation.js";

export interface DistributionStats {
  min: number;
  max: number;
  mean: number;
  stdDev: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

export interface SimulationReport {
  game: {
    id: string;
    declaredRtp: number;
    defaultMode: string;
  };
  mode: {
    id: string;
    label?: string;
    stakeMultiplier: number;
    internal: boolean;
  };
  math: {
    name: string;
    version: string;
    declaredRtp: number;
    kind: "simple" | "complex";
  };
  /** Number of spins simulated for this mode. */
  spins: number;
  bet: {
    /** Units used per spin (post-stake-multiplier). */
    unitsPerSpin: number;
    totalUnits: number;
  };
  win: {
    totalUnits: number;
    /** Largest single-spin multiplier observed. */
    maxMultiplier: number;
  };
  rtp: {
    measured: number;   // total_win / total_bet
    declared: number;   // from manifest
    delta: number;      // measured - declared
  };
  /** Fraction of spins with multiplier > 0. */
  hitRate: number;
  /** Distribution stats on the per-spin multiplier. */
  multiplier: DistributionStats;
  /** Count of spins by outcome `type` returned from math. */
  outcomeTypes: Record<string, number>;
  /** Count of spins that emitted a `nextMode` route to each target. */
  nextModeRoutes: Record<string, number>;

  /** ── Author-annotated marks (only present if math used host.mark.*) ── */

  /** Per-name total of host.mark.count() calls (across all spins).
   *  Convenient view: counters[name] / spins = fire rate. */
  counters: Record<string, { total: number; perSpin: number }>;
  /** Per-name distribution stats over host.mark.observe(name, value) samples. */
  observations: Record<string, DistributionStats & { count: number }>;
  /** Per-name share of spins on which host.mark.tag(name) was called. */
  tagShares: Record<string, { spins: number; share: number }>;
  /** Per-name share of total RTP that came from host.mark.contribute(name, m) buckets. */
  rtpContributions: Record<string, { sumMultiplier: number; rtpShare: number }>;
  /** Per-key deviation entries (empty if math has no `expected` block). */
  deviations: TargetDeviation[];
  /** Single-line machine-readable diagnosis. */
  narrative: string;

  /** Complex-round-only stats. */
  complex?: {
    averageStepsPerRound: number;
  };
  /** Platform-adapter call stats. Only present when the simulator
   *  was run with a real (or test) PlatformAdapter in options. Counts
   *  each spin's settleSimple/closeComplex round trip. */
  adapter?: {
    rpcsSent:    number;
    rpcsOk:      number;
    rpcsFailed:  number;
    /** Wall-clock time spent inside adapter calls. */
    rpcMsTotal:  number;
    /** Per-error-message tally. Useful for spotting one class of
     *  failure dominating the rest (e.g. RoundState validator). */
    failuresByMessage: Record<string, number>;
  };
  /** Wall-clock time spent simulating this mode. */
  elapsedMs: number;
}

/** Render one SimulationReport as a tidy markdown block. */
export function mdReport(r: SimulationReport): string {
  const pct = (n: number) => (n * 100).toFixed(2) + "%";
  const sign = (n: number) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
  const num = (n: number, d = 4) => n.toFixed(d);

  const lines: string[] = [];
  lines.push(`# Simulation — ${r.game.id} / ${r.mode.id}`);
  lines.push("");
  if (r.mode.label) lines.push(`*${r.mode.label}* · math ${r.math.name}@${r.math.version} (${r.math.kind})`);
  else              lines.push(`math ${r.math.name}@${r.math.version} (${r.math.kind})`);
  lines.push("");
  lines.push(`> ${r.narrative}`);
  lines.push("");
  lines.push(`- **Measured RTP:** ${pct(r.rtp.measured)} (declared ${pct(r.rtp.declared)}, Δ ${sign(r.rtp.delta)})`);
  lines.push(`- **Hit rate:** ${pct(r.hitRate)}`);
  lines.push(`- **Spins:** ${r.spins.toLocaleString()} · **Bet:** ${r.bet.unitsPerSpin}u/spin · **Time:** ${r.elapsedMs}ms`);
  lines.push(`- **Stake multiplier:** ${r.mode.stakeMultiplier}× · **Internal:** ${r.mode.internal ? "yes" : "no"}`);
  lines.push("");

  if (r.deviations.length > 0) {
    lines.push("## Targets vs measured");
    lines.push("");
    lines.push("| metric                            | target  | measured | Δ        | tolerance | status |");
    lines.push("|-----------------------------------|---------|----------|----------|-----------|--------|");
    for (const d of r.deviations) {
      lines.push(`| ${d.key.padEnd(33)} | ${num(d.target)} | ${num(d.measured)} | ${sign(d.delta / Math.max(Math.abs(d.target), 1e-9))} | ±${num(d.tolerance)} | ${d.status} |`);
    }
    lines.push("");
  }

  lines.push("## Multiplier distribution");
  lines.push("");
  lines.push("| stat   | value   |");
  lines.push("|--------|---------|");
  lines.push(`| min    | ${num(r.multiplier.min)} |`);
  lines.push(`| mean   | ${num(r.multiplier.mean)} |`);
  lines.push(`| stddev | ${num(r.multiplier.stdDev)} |`);
  lines.push(`| p50    | ${num(r.multiplier.p50)} |`);
  lines.push(`| p90    | ${num(r.multiplier.p90)} |`);
  lines.push(`| p95    | ${num(r.multiplier.p95)} |`);
  lines.push(`| p99    | ${num(r.multiplier.p99)} |`);
  lines.push(`| max    | ${num(r.multiplier.max)} |`);
  lines.push("");

  const typeEntries = Object.entries(r.outcomeTypes).sort((a, b) => b[1] - a[1]);
  if (typeEntries.length > 0) {
    lines.push("## Outcome types");
    lines.push("");
    lines.push("| type            | count        | share   |");
    lines.push("|-----------------|--------------|---------|");
    for (const [t, n] of typeEntries) {
      lines.push(`| ${t.padEnd(15)} | ${n.toLocaleString().padStart(12)} | ${pct(n / r.spins)} |`);
    }
    lines.push("");
  }

  const routeEntries = Object.entries(r.nextModeRoutes).sort((a, b) => b[1] - a[1]);
  if (routeEntries.length > 0) {
    lines.push("## Next-mode routes");
    lines.push("");
    lines.push("| target          | count        | share   |");
    lines.push("|-----------------|--------------|---------|");
    for (const [t, n] of routeEntries) {
      lines.push(`| ${t.padEnd(15)} | ${n.toLocaleString().padStart(12)} | ${pct(n / r.spins)} |`);
    }
    lines.push("");
  }

  const counterEntries = Object.entries(r.counters).sort((a, b) => b[1].total - a[1].total);
  if (counterEntries.length > 0) {
    lines.push("## Counters (host.mark.count)");
    lines.push("");
    lines.push("| name                          | total        | per spin   |");
    lines.push("|-------------------------------|--------------|------------|");
    for (const [name, c] of counterEntries) {
      lines.push(`| ${name.padEnd(29)} | ${c.total.toLocaleString().padStart(12)} | ${c.perSpin.toFixed(5).padStart(10)} |`);
    }
    lines.push("");
  }

  const obsEntries = Object.entries(r.observations);
  if (obsEntries.length > 0) {
    lines.push("## Observations (host.mark.observe)");
    lines.push("");
    lines.push("| name                  | count   | mean    | stddev  | p50    | p90    | p99    | max     |");
    lines.push("|-----------------------|---------|---------|---------|--------|--------|--------|---------|");
    for (const [name, o] of obsEntries) {
      lines.push(`| ${name.padEnd(21)} | ${o.count.toString().padStart(7)} | ${num(o.mean).padStart(7)} | ${num(o.stdDev).padStart(7)} | ${num(o.p50).padStart(6)} | ${num(o.p90).padStart(6)} | ${num(o.p99).padStart(6)} | ${num(o.max).padStart(7)} |`);
    }
    lines.push("");
  }

  const tagEntries = Object.entries(r.tagShares).sort((a, b) => b[1].spins - a[1].spins);
  if (tagEntries.length > 0) {
    lines.push("## Tag shares (host.mark.tag)");
    lines.push("");
    lines.push("| tag                   | spins        | share   |");
    lines.push("|-----------------------|--------------|---------|");
    for (const [name, t] of tagEntries) {
      lines.push(`| ${name.padEnd(21)} | ${t.spins.toLocaleString().padStart(12)} | ${pct(t.share)} |`);
    }
    lines.push("");
  }

  const ctbEntries = Object.entries(r.rtpContributions).sort((a, b) => b[1].rtpShare - a[1].rtpShare);
  if (ctbEntries.length > 0) {
    lines.push("## RTP contributions (host.mark.contribute)");
    lines.push("");
    lines.push("| bucket                | sum multiplier | RTP share |");
    lines.push("|-----------------------|----------------|-----------|");
    for (const [name, c] of ctbEntries) {
      lines.push(`| ${name.padEnd(21)} | ${num(c.sumMultiplier, 2).padStart(14)} | ${pct(c.rtpShare).padStart(9)} |`);
    }
    lines.push("");
  }

  if (r.complex) {
    lines.push("## Complex-round stats");
    lines.push("");
    lines.push(`- Average steps per round: **${r.complex.averageStepsPerRound.toFixed(2)}**`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Render all reports as one markdown document with a top-level summary. */
export function mdReportSet(reports: readonly SimulationReport[]): string {
  if (reports.length === 0) return "_No modes simulated._";

  const game = reports[0]!.game;
  const pct = (n: number) => (n * 100).toFixed(2) + "%";

  const lines: string[] = [];
  lines.push(`# Simulation report — ${game.id}`);
  lines.push("");
  lines.push(`Declared game RTP: **${pct(game.declaredRtp)}**`);
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| mode            | spins      | measured RTP | declared | Δ           | hit rate | targets       |");
  lines.push("|-----------------|------------|--------------|----------|-------------|----------|---------------|");
  for (const r of reports) {
    const delta = (r.rtp.delta >= 0 ? "+" : "") + (r.rtp.delta * 100).toFixed(2) + "%";
    const fails = r.deviations.filter(d => d.status === "fail").length;
    const warns = r.deviations.filter(d => d.status === "warn").length;
    const oks   = r.deviations.filter(d => d.status === "ok").length;
    const tgts  = r.deviations.length === 0 ? "—" : `${oks} ok · ${warns} warn · ${fails} fail`;
    lines.push(
      `| ${r.mode.id.padEnd(15)} | ${r.spins.toLocaleString().padStart(10)} | ${pct(r.rtp.measured).padStart(12)} | ${pct(r.rtp.declared).padStart(8)} | ${delta.padStart(11)} | ${pct(r.hitRate).padStart(8)} | ${tgts.padEnd(13)} |`,
    );
  }
  lines.push("");

  for (const r of reports) {
    lines.push("---");
    lines.push("");
    lines.push(mdReport(r));
  }

  return lines.join("\n");
}
