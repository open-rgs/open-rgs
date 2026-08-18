// @open-rgs/gamble - risk what you just won.
//
// The oldest feature in the genre and the easiest to misprice, because the
// interesting number is not the win, it is the EDGE: a double-or-nothing at
// exactly p = 0.5 returns 100% of what is staked, so a game that offers it
// returns more than its base RTP to any player who uses it. Every function
// here takes the chance explicitly and reports what the round is worth, so the
// edge is a number you chose rather than one you discover in a report.
//
// Nothing here draws randomness: `next` is host.rng_next, and every amount is
// a multiple of bet.

// --- one step ----------------------------------------------------------------

export interface GambleStep {
  /** Chance of winning this step, in [0, 1]. */
  readonly chance: number;
  /** What the stake becomes on a win. 2 is double-or-nothing. */
  readonly on: number;
  /** What is left on a loss. 0 is the classic; a "half gamble" keeps half. */
  readonly onLoss?: number;
}

export interface GambleResult {
  readonly won: boolean;
  /** The stake after this step. */
  readonly stake: number;
}

/** Play one step against the generator. */
export function gambleOnce(stake: number, step: GambleStep, next: () => number): GambleResult {
  assertStake(stake);
  assertStep(step);
  const won = next() < step.chance;
  return { won, stake: won ? stake * step.on : stake * (step.onLoss ?? 0) };
}

/**
 * Return per unit staked on one step.
 *
 * `1` is a fair gamble, which returns everything staked and adds RTP to a game
 * that offers it. Below 1 the step carries an edge; above 1 it pays the player
 * to keep gambling, which is a mistake rather than a feature.
 */
export function stepReturn(step: GambleStep): number {
  assertStep(step);
  return step.chance * step.on + (1 - step.chance) * (step.onLoss ?? 0);
}

/** The house edge of a step, as a fraction of the stake. Negative means the
 *  step pays the player to take it. */
export function stepEdge(step: GambleStep): number {
  return 1 - stepReturn(step);
}

/** The chance that makes a step exactly fair, for a given payout. Solve once,
 *  then decide how far under it to sit. */
export function fairChance(on: number, onLoss = 0): number {
  if (!(on > onLoss)) throw new Error(`fairChance: 'on' must exceed 'onLoss' (${on} <= ${onLoss})`);
  return (1 - onLoss) / (on - onLoss);
}

// --- a ladder ----------------------------------------------------------------

export interface LadderOptions {
  /** Stop after this many won steps, however brave the player is. Every
   *  gamble needs one: without it the round's max win is unbounded and the
   *  engine's cap becomes the only thing ending it. */
  readonly maxSteps: number;
  /** Cap on the stake, in bet multiples. Reaching it ends the round. */
  readonly maxStake?: number;
}

export interface LadderRound {
  /** Stake at the end. Zero when a step was lost. */
  readonly stake: number;
  /** Steps actually played. */
  readonly steps: number;
  /** True when a step was lost. */
  readonly busted: boolean;
  /** True when the round ended on a limit rather than a decision. */
  readonly cappedOut: boolean;
  /** Stake after each played step, for the replay. */
  readonly history: readonly number[];
}

/**
 * Climb while `keepGoing` says to and the limits allow it.
 *
 * `keepGoing` is the player's policy: a client decision in a real round, and
 * whatever you want to price against in a simulation. It sees the stake and
 * the number of steps taken, which is everything a player sees.
 */
export function gambleLadder(
  stake: number,
  step: GambleStep,
  keepGoing: (stake: number, steps: number) => boolean,
  next: () => number,
  opts: LadderOptions,
): LadderRound {
  assertStake(stake);
  assertStep(step);
  if (!Number.isInteger(opts.maxSteps) || opts.maxSteps < 0) {
    throw new Error(`gambleLadder: maxSteps must be a non-negative integer, got ${opts.maxSteps}`);
  }
  let current = stake;
  let steps = 0;
  const history: number[] = [];
  let cappedOut = false;

  while (steps < opts.maxSteps && current > 0 && keepGoing(current, steps)) {
    const result = gambleOnce(current, step, next);
    current = result.stake;
    steps++;
    history.push(current);
    if (!result.won) return { stake: 0, steps, busted: true, cappedOut: false, history };
    if (opts.maxStake !== undefined && current >= opts.maxStake) {
      current = Math.min(current, opts.maxStake);
      history[history.length - 1] = current;
      cappedOut = true;
      break;
    }
  }
  if (steps === opts.maxSteps && !cappedOut && opts.maxSteps > 0) cappedOut = true;
  return { stake: current, steps, busted: false, cappedOut, history };
}

/**
 * Expected return of climbing exactly `steps` times, per unit staked.
 *
 * With a fair step this is 1 whatever `steps` is, which is the point: a fair
 * ladder does not change RTP, it changes variance. With an edge it decays
 * geometrically, so the fifth rung of a 2% edge costs about a tenth of the
 * stake. A player who always climbs is the case to price against.
 */
export function ladderReturn(step: GambleStep, steps: number): number {
  if (!Number.isInteger(steps) || steps < 0) throw new Error(`ladderReturn: steps must be a non-negative integer, got ${steps}`);
  return stepReturn(step) ** steps;
}

/** Chance of surviving `steps` in a row. The number a player is really
 *  betting against, and usually smaller than it feels. */
export function survivalChance(step: GambleStep, steps: number): number {
  assertStep(step);
  return step.chance ** Math.max(0, steps);
}

// --- collect or risk ---------------------------------------------------------

/**
 * The other shape: a prize that grows while the player declines to collect,
 * and is lost on a failed step.
 *
 * Same arithmetic as a ladder, different presentation, and worth its own
 * function because the growth is additive rather than multiplicative, which
 * changes the edge per step as the prize climbs.
 */
export function collectOrRisk(
  prize: number,
  add: number,
  chance: number,
  keepGoing: (prize: number, steps: number) => boolean,
  next: () => number,
  opts: LadderOptions,
): LadderRound {
  assertStake(prize);
  if (!(chance >= 0 && chance <= 1)) throw new Error(`collectOrRisk: chance must be in [0, 1], got ${chance}`);
  let current = prize;
  let steps = 0;
  const history: number[] = [];

  while (steps < opts.maxSteps && keepGoing(current, steps)) {
    steps++;
    if (next() >= chance) {
      history.push(0);
      return { stake: 0, steps, busted: true, cappedOut: false, history };
    }
    current += add;
    history.push(current);
    if (opts.maxStake !== undefined && current >= opts.maxStake) {
      return { stake: Math.min(current, opts.maxStake), steps, busted: false, cappedOut: true, history };
    }
  }
  return { stake: current, steps, busted: false, cappedOut: steps === opts.maxSteps && opts.maxSteps > 0, history };
}

// --- guards ------------------------------------------------------------------

function assertStake(stake: number): void {
  if (!Number.isFinite(stake) || stake < 0) {
    throw new Error(`gamble: stake must be a non-negative number of bet multiples, got ${stake}`);
  }
}

function assertStep(step: GambleStep): void {
  if (!(step.chance >= 0 && step.chance <= 1)) {
    throw new Error(`gamble: chance must be a probability in [0, 1], got ${step.chance}`);
  }
  if (!Number.isFinite(step.on) || step.on < 0) {
    throw new Error(`gamble: 'on' must be a non-negative multiplier, got ${step.on}`);
  }
  const onLoss = step.onLoss ?? 0;
  if (!Number.isFinite(onLoss) || onLoss < 0) {
    throw new Error(`gamble: 'onLoss' must be a non-negative multiplier, got ${onLoss}`);
  }
}
