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
  AwaitingHint, PlayerAction, SpinContext, CarryState, Op,
  MarkSnapshot, MarkCollector,
  PlatformAdapter,
} from "@open-rgs/contract";
import { mulberry32 } from "./rng.js";
import { mean, stdDev, percentileSorted } from "./stats.js";
import { computeDeviations, narrate, type TargetDeviation } from "./deviation.js";
import type { SimulationReport, DistributionStats } from "./report.js";
import { createFlowRecorder, type FlowLabel, type FlowRecorder } from "./flow.js";

/** Round to nearest integer, ties to even (banker's rounding)  - the money
 *  boundary rule from ADR-002. Mirrors @open-rgs/core's `roundHalfEven`;
 *  duplicated here because the simulator deliberately has no core dep. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Public context a complex-round strategy sees at each decision point - exactly
 *  what a real client has: the `awaiting` hint plus the latest public `ops` the
 *  math emitted (its projection of the round). NOT the opaque `state` blob; a
 *  strategy acts only on what a player can actually see. */
export interface StrategyContext {
  awaiting: AwaitingHint;
  /** The most recent open()/step() `ops` - the math's public view of the round. */
  ops: Op[];
  /** 0-based decision index within the current round. */
  step: number;
  /** The simulator's seeded PRNG, so strategy randomness stays reproducible. */
  rng: () => number;
}

/** A complex-round policy: given the public context, choose the next action.
 *  This is how you model "keep gambling N times", blackjack basic strategy,
 *  an optimal solver, etc. */
export type StrategyFn = (ctx: StrategyContext) => PlayerAction;

/** Built-in names or a custom policy function. */
export type ComplexStrategy = "first" | "random" | StrategyFn;

export interface SimulateOptions {
  /** Spins to run per mode. Default 100_000. */
  spinsPerMode?: number;
  /** Units bet per spin BEFORE the mode's stakeMultiplier. Default 1. */
  betUnits?: number;
  /** Include `internal: true` modes (those only reachable via nextMode).
   *  Defaults to true  - you usually want the internal-mode RTP measured
   *  independently for math review. */
  includeInternal?: boolean;
  /** Complex-round step strategy. Default "first".
   *  - "first":  always pick awaiting.options[0]
   *  - "random": pick from awaiting.options uniformly (seeded  - see seed)
   *  - a StrategyFn: your own policy, called at each decision with the public
   *    context (awaiting + latest public ops + step index + the sim rng). */
  complexStrategy?: ComplexStrategy;
  /** Seed for the simulator's *own* PRNG (drives "random" strategy and
   *  any tie-breaking). Does NOT seed the math  - see top-of-file note. */
  seed?: number;
  /** Safety cap on steps per complex round to avoid infinite loops in
   *  buggy maths. Default 1000. */
  maxStepsPerRound?: number;
  /** Record a play-flow graph (a Markov chain of how rounds were played) onto
   *  `report.flow`, rendered as a Mermaid chart + transition table by mdReport.
   *  `true` labels decision nodes by `awaiting.type`; pass `{ label }` to bucket
   *  nodes from the public context (awaiting + ops) for a richer chart.
   *  Complex modes only. */
  flow?: boolean | { label?: FlowLabel };
  /** OPTIONAL platform adapter. When set, each generated spin is
   *  settled via `adapter.settleSimple(...)` (or close/openComplex
   *  for complex maths) so adapter-shape mismatches surface during
   *  the pre-deploy sim run instead of in production.
   *
   *  Caller MUST connect the adapter and openSession beforehand,
   *  pass the sessionId, and disconnect after simulate() returns.
   *  Spin loop runs at math speed (~= microseconds per spin), so
   *  using a real adapter implies real wallet movements at the
   *  upstream  - only point this at a sandbox account. */
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
  const flowLabel: FlowLabel = (typeof opts.flow === "object" && opts.flow.label) ? opts.flow.label : (c) => c.awaiting.type;
  const flowRec: FlowRecorder | undefined = opts.flow && mode.math.kind === "complex" ? createFlowRecorder() : undefined;
  const marks: MarkCollector | undefined = mode.math.marks;

  const multipliers: number[] = new Array<number>(spins);
  const outcomeTypes: Record<string, number> = {};
  const nextModeRoutes: Record<string, number> = {};
  let totalWin = 0;
  let totalSteps = 0;
  // Cross-round carry threaded spin-to-spin, exactly as the orchestrator does
  // it. Passing `undefined` every spin (the old behaviour) made any stateful
  // game's measured RTP wrong. (H7)
  let carry: CarryState | undefined;

  // Optional adapter integration  - when set, each spin is settled via
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
      const outcome = await Promise.resolve(m.play(carry, ctx));
      multiplier = outcome.multiplier;
      type = outcome.type;
      nextMode = outcome.nextMode;
      carry = outcome.carry;
    } else {
      const m = mode.math as ComplexMath;
      const ctx: SpinContext = { mode: modeId };
      const open = await Promise.resolve(m.open(carry, ctx));
      let state = open.state;
      let awaiting: AwaitingHint | undefined = open.awaiting;
      let lastOps: Op[] = open.ops;
      let steps = 0;
      const path: Array<{ label: string; action: string }> = [];
      while (steps < maxSteps && !(await Promise.resolve(m.isTerminal(state)))) {
        if (!awaiting) break;
        const action = pickAction(awaiting, lastOps, steps, complexStrategy, stratRng);
        if (flowRec) path.push({ label: flowLabel({ awaiting, ops: lastOps, step: steps }), action: String(action["value"] ?? action.type) });
        const step = await Promise.resolve(m.step(state, action));
        state = step.state;
        awaiting = step.awaiting;
        lastOps = step.ops;
        steps += 1;
      }
      totalSteps += steps;
      const close = await Promise.resolve(m.close(state));
      multiplier = close.multiplier;
      type = close.type;
      nextMode = close.nextMode;
      carry = close.carry;
      if (flowRec) flowRec.round(path, type);
    }

    multipliers[i] = multiplier;
    totalWin += multiplier * betPerSpin;
    outcomeTypes[type] = (outcomeTypes[type] ?? 0) + 1;
    if (nextMode) nextModeRoutes[nextMode] = (nextModeRoutes[nextMode] ?? 0) + 1;

    if (adapter && adapterSession) {
      const tStart = performance.now();
      adapterRpcsSent += 1;
      // The adapter is a real wallet expecting integer minor units, so the
      // settled win must be rounded exactly as core's orchestrator does
      // (round half to even, ADR-002)  - not the raw float `multiplier x
      // bet`. (The theoretical `totalWin` above stays exact on purpose: it
      // measures RTP, not what a wallet would actually credit.)
      const winMinor = roundHalfEven(multiplier * betPerSpin);
      try {
        await adapter.settleSimple({
          sessionId:       adapterSession,
          bet:             betPerSpin,
          betIndex:        adapterBetIdx,
          priceMultiplier: betUnits,
          win:             winMinor,
          multiplier,
          type,
          // Synthesize a per-spin audit envelope; core's orchestrator
          // does the same when math carry is absent.
          roundState: JSON.stringify({
            type, multiplier, win: winMinor, bet: betPerSpin, bet_index: adapterBetIdx,
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

  // RTP certification verdict. The measured RTP is the mean per-spin return;
  // its standard error is stdDev(per-spin multiplier)/sqrtn. We can then say
  // whether the declared RTP is statistically consistent with what we
  // measured: within the 95% CI -> pass; within 99% -> warn; outside -> fail.
  const standardError = spins > 0 ? muStd / Math.sqrt(spins) : 0;
  const ci95: [number, number] = [measuredRtp - 1.96 * standardError, measuredRtp + 1.96 * standardError];
  const rtpDelta = Math.abs(declaredRtp - measuredRtp);
  let rtpVerdict: "pass" | "warn" | "fail";
  if (standardError === 0) {
    rtpVerdict = rtpDelta < 1e-9 ? "pass" : "fail";
  } else if (rtpDelta <= 1.96 * standardError) {
    rtpVerdict = "pass";
  } else if (rtpDelta <= 2.576 * standardError) {
    rtpVerdict = "warn";
  } else {
    rtpVerdict = "fail";
  }

  let hits = 0;
  for (const m of multipliers) if (m > 0) hits += 1;
  const hitRate = spins === 0 ? 0 : hits / spins;

  // -- Marks: compute counter/observation/tag/contribution sections --
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
      standardError,
      ci95,
      verdict: rtpVerdict,
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
    ...(flowRec ? { flow: flowRec.graph() } : {}),
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
  ops: Op[],
  step: number,
  strategy: ComplexStrategy,
  rng: () => number,
): PlayerAction {
  if (typeof strategy === "function") return strategy({ awaiting, ops, step, rng });
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
