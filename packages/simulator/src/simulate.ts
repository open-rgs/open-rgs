// Per-mode RTP simulator. Replays the math thousands of times, drives
// host.mark.* lifecycle, and produces a SimulationReport for each mode
// (with deviation entries when the math declares an `expected` block).
//
// Determinism note: the math's RNG is wired at loadLuaMath time, not
// here. To get reproducible reports across runs, seed the math:
//
//   import { mulberry32 } from "@open-rgs/simulator/rng";
//   const math = await loadLuaMath("./maths/spin.lua", { rng: mulberry32(42) });
//
// The simulator's `seed` option only seeds the complex-round step strategy.

import type {
  GameManifest, GameMode,
  SimpleMath, ComplexMath,
  AwaitingHint, PlayerAction, SpinContext,
  MarkSnapshot, MarkCollector,
  PlatformAdapter,
} from "@open-rgs/contract";
import { mulberry32 } from "./rng.js";
import { mean, stdDev, percentileSorted } from "./stats.js";
import { computeDeviations, narrate, type TargetDeviation } from "./deviation.js";
import type { SimulationReport, DistributionStats } from "./report.js";

export interface SimulateOptions {
  /** Spins to run per mode. Default 100_000. */
  spinsPerMode?: number;
  /** Units bet per spin BEFORE the mode's stakeMultiplier. Default 1. */
  betUnits?: number;
  /** Include `internal: true` modes (those only reachable via nextMode).
   *  Defaults to true — you usually want the internal-mode RTP measured
   *  independently for math review. */
  includeInternal?: boolean;
  /** Complex-round step strategy. Default "first".
   *  - "first":  always pick awaiting.options[0]
   *  - "random": pick from awaiting.options uniformly (seeded — see seed) */
  complexStrategy?: "first" | "random";
  /** Seed for the simulator's *own* PRNG (drives "random" strategy and
   *  any tie-breaking). Does NOT seed the math — see top-of-file note. */
  seed?: number;
  /** Safety cap on steps per complex round to avoid infinite loops in
   *  buggy maths. Default 1000. */
  maxStepsPerRound?: number;
  /** OPTIONAL platform adapter. When set, each generated spin is
   *  settled via `adapter.settleSimple(...)` (or close/openComplex
   *  for complex maths) so adapter-shape mismatches surface during
   *  the pre-deploy sim run instead of in production.
   *
   *  Caller MUST connect the adapter and openSession beforehand,
   *  pass the sessionId, and disconnect after simulate() returns.
   *  Spin loop runs at math speed (≈ microseconds per spin), so
   *  using a real adapter implies real wallet movements at the
   *  upstream — only point this at a sandbox account. */
  adapter?: PlatformAdapter;
  /** Session id to thread through adapter calls. Required when
   *  `adapter` is set. */
  adapterSessionId?: string;
  /** Bet index used in adapter calls. Default 0. */
  adapterBetIndex?: number;
}

/** Simulate every mode in the manifest. Returns one report per mode in
 *  the manifest's declared order (filtered by includeInternal). */
export async function simulate(
  manifest: GameManifest,
  opts: SimulateOptions = {},
): Promise<SimulationReport[]> {
  const reports: SimulationReport[] = [];
  for (const [modeId, mode] of Object.entries(manifest.modes)) {
    if (mode.internal && opts.includeInternal === false) continue;
    reports.push(await simulateMode(manifest, modeId, mode, opts));
  }
  return reports;
}

async function simulateMode(
  manifest: GameManifest,
  modeId: string,
  mode: GameMode,
  opts: SimulateOptions,
): Promise<SimulationReport> {
  const spins = opts.spinsPerMode ?? 100_000;
  const betUnits = opts.betUnits ?? 1;
  const betPerSpin = betUnits * mode.stakeMultiplier;
  const stratRng = mulberry32(opts.seed ?? 0);
  const maxSteps = opts.maxStepsPerRound ?? 1000;
  const complexStrategy = opts.complexStrategy ?? "first";
  const marks: MarkCollector | undefined = mode.math.marks;

  const multipliers: number[] = new Array<number>(spins);
  const outcomeTypes: Record<string, number> = {};
  const nextModeRoutes: Record<string, number> = {};
  let totalWin = 0;
  let totalSteps = 0;

  // Optional adapter integration — when set, each spin is settled via
  // the real adapter so wire-protocol bugs (validator mismatches, auth
  // drift, envelope shape errors) surface during sim instead of prod.
  const adapter        = opts.adapter;
  const adapterSession = opts.adapterSessionId;
  const adapterBetIdx  = opts.adapterBetIndex ?? 0;
  if (adapter && !adapterSession) {
    throw new Error("simulate({ adapter }) requires adapterSessionId");
  }
  let adapterRpcsSent = 0;
  let adapterRpcsOk = 0;
  let adapterRpcsFailed = 0;
  let adapterMsTotal = 0;
  const adapterFailures: Record<string, number> = {};

  const start = performance.now();

  for (let i = 0; i < spins; i++) {
    marks?.beginSpin();

    let multiplier: number;
    let type: string;
    let nextMode: string | undefined;

    if (mode.math.kind === "simple") {
      const m = mode.math as SimpleMath;
      const ctx: SpinContext = { mode: modeId };
      const outcome = await Promise.resolve(m.play(undefined, ctx));
      multiplier = outcome.multiplier;
      type = outcome.type;
      nextMode = outcome.nextMode;
    } else {
      const m = mode.math as ComplexMath;
      const ctx: SpinContext = { mode: modeId };
      const open = await Promise.resolve(m.open(undefined, ctx));
      let state = open.state;
      let awaiting: AwaitingHint | undefined = open.awaiting;
      let steps = 0;
      while (steps < maxSteps && !(await Promise.resolve(m.isTerminal(state)))) {
        if (!awaiting) break;
        const action = pickAction(awaiting, complexStrategy, stratRng);
        const step = await Promise.resolve(m.step(state, action));
        state = step.state;
        awaiting = step.awaiting;
        steps += 1;
      }
      totalSteps += steps;
      const close = await Promise.resolve(m.close(state));
      multiplier = close.multiplier;
      type = close.type;
      nextMode = close.nextMode;
    }

    multipliers[i] = multiplier;
    totalWin += multiplier * betPerSpin;
    outcomeTypes[type] = (outcomeTypes[type] ?? 0) + 1;
    if (nextMode) nextModeRoutes[nextMode] = (nextModeRoutes[nextMode] ?? 0) + 1;

    if (adapter && adapterSession) {
      const tStart = performance.now();
      adapterRpcsSent += 1;
      try {
        await adapter.settleSimple({
          sessionId:       adapterSession,
          bet:             betPerSpin,
          betIndex:        adapterBetIdx,
          priceMultiplier: betUnits,
          win:             multiplier * betPerSpin,
          multiplier,
          type,
          // Synthesize a per-spin audit envelope; core's orchestrator
          // does the same when math carry is absent.
          roundState: JSON.stringify({
            type, multiplier, win: multiplier * betPerSpin, bet: betPerSpin, bet_index: adapterBetIdx,
          }),
          ...(mode.math.version ? { mathVersion: mode.math.version } : {}),
        });
        adapterRpcsOk += 1;
      } catch (e) {
        adapterRpcsFailed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        adapterFailures[msg] = (adapterFailures[msg] ?? 0) + 1;
      }
      adapterMsTotal += performance.now() - tStart;
    }

    marks?.endSpin();
  }

  const elapsedMs = Math.round(performance.now() - start);

  // Stats over the multiplier distribution.
  const sorted = [...multipliers].sort((a, b) => a - b);
  const muMean = mean(multipliers);
  const muStd  = stdDev(multipliers, muMean);
  const muMin  = sorted[0] ?? 0;
  const muMax  = sorted[sorted.length - 1] ?? 0;

  const totalBet = spins * betPerSpin;
  const measuredRtp = totalBet === 0 ? 0 : totalWin / totalBet;
  const declaredRtp = mode.declaredRtp ?? mode.math.rtp;

  let hits = 0;
  for (const m of multipliers) if (m > 0) hits += 1;
  const hitRate = spins === 0 ? 0 : hits / spins;

  // ── Marks: compute counter/observation/tag/contribution sections ──
  const snap: MarkSnapshot = marks?.snapshot() ?? {
    counts: {}, observations: {}, tagSpins: {}, contributions: {}, spinsCompleted: 0,
  };

  const counters: SimulationReport["counters"] = {};
  for (const [name, total] of Object.entries(snap.counts)) {
    counters[name] = { total, perSpin: spins === 0 ? 0 : total / spins };
  }

  const observations: SimulationReport["observations"] = {};
  for (const [name, values] of Object.entries(snap.observations)) {
    if (values.length === 0) continue;
    const s = [...values].sort((a, b) => a - b);
    const m = mean(values);
    observations[name] = {
      count: values.length,
      min: s[0]!,
      max: s[s.length - 1]!,
      mean: m,
      stdDev: stdDev(values, m),
      p50: percentileSorted(s, 50),
      p90: percentileSorted(s, 90),
      p95: percentileSorted(s, 95),
      p99: percentileSorted(s, 99),
    };
  }

  const tagShares: SimulationReport["tagShares"] = {};
  for (const [name, n] of Object.entries(snap.tagSpins)) {
    tagShares[name] = { spins: n, share: spins === 0 ? 0 : n / spins };
  }

  const rtpContributions: SimulationReport["rtpContributions"] = {};
  const rates: Record<string, number> = {};
  for (const [name, total] of Object.entries(snap.counts)) {
    rates[name] = spins === 0 ? 0 : total / spins;
  }
  for (const [name, sumMultiplier] of Object.entries(snap.contributions)) {
    const rtpShare = totalBet === 0 ? 0 : (sumMultiplier * betPerSpin) / totalBet;
    rtpContributions[name] = { sumMultiplier, rtpShare };
  }

  const tagShareRates: Record<string, number> = {};
  for (const [name, n] of Object.entries(snap.tagSpins)) {
    tagShareRates[name] = spins === 0 ? 0 : n / spins;
  }

  const deviations: TargetDeviation[] = computeDeviations(mode.math.expected, {
    hitRate,
    rates,
    rtpContributions: Object.fromEntries(Object.entries(rtpContributions).map(([k, v]) => [k, v.rtpShare])),
    tagShares: tagShareRates,
  });

  const topContributions = Object.entries(rtpContributions)
    .map(([name, c]) => ({ name, rtpShare: c.rtpShare }))
    .sort((a, b) => b.rtpShare - a.rtpShare);

  const narrative = narrate(
    manifest.id,
    modeId,
    { measured: measuredRtp, declared: declaredRtp, delta: measuredRtp - declaredRtp },
    hitRate,
    deviations,
    topContributions,
  );

  const multiplierStats: DistributionStats = {
    min: muMin,
    max: muMax,
    mean: muMean,
    stdDev: muStd,
    p50: percentileSorted(sorted, 50),
    p90: percentileSorted(sorted, 90),
    p95: percentileSorted(sorted, 95),
    p99: percentileSorted(sorted, 99),
  };

  const report: SimulationReport = {
    game: {
      id: manifest.id,
      declaredRtp: manifest.declaredRtp,
      defaultMode: manifest.defaultMode,
    },
    mode: {
      id: modeId,
      ...(mode.label !== undefined ? { label: mode.label } : {}),
      stakeMultiplier: mode.stakeMultiplier,
      internal: mode.internal ?? false,
    },
    math: {
      name: mode.math.name,
      version: mode.math.version,
      declaredRtp,
      kind: mode.math.kind,
    },
    spins,
    bet: { unitsPerSpin: betPerSpin, totalUnits: totalBet },
    win: { totalUnits: totalWin, maxMultiplier: muMax },
    rtp: {
      measured: measuredRtp,
      declared: declaredRtp,
      delta: measuredRtp - declaredRtp,
    },
    hitRate,
    multiplier: multiplierStats,
    outcomeTypes,
    nextModeRoutes,
    counters,
    observations,
    tagShares,
    rtpContributions,
    deviations,
    narrative,
    ...(mode.math.kind === "complex"
      ? { complex: { averageStepsPerRound: spins === 0 ? 0 : totalSteps / spins } }
      : {}),
    ...(adapter
      ? { adapter: {
          rpcsSent:    adapterRpcsSent,
          rpcsOk:      adapterRpcsOk,
          rpcsFailed:  adapterRpcsFailed,
          rpcMsTotal:  Math.round(adapterMsTotal),
          failuresByMessage: adapterFailures,
        } }
      : {}),
    elapsedMs,
  };

  return report;
}

function pickAction(
  awaiting: AwaitingHint,
  strategy: "first" | "random",
  rng: () => number,
): PlayerAction {
  const options = awaiting.options;
  if (!options || options.length === 0) {
    return { type: awaiting.type };
  }
  if (strategy === "random") {
    const idx = Math.floor(rng() * options.length);
    return { type: awaiting.type, value: options[idx] };
  }
  return { type: awaiting.type, value: options[0] };
}
