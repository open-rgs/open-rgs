// @open-rgs/freespins - the feature almost every slot has, and the four
// decisions inside it.
//
// A free-spin round is a small state machine: some number of spins, a running
// total, and whatever persists between the spins. The mechanics that make one
// feature different from another all live in that last part, so they are here
// as separate pieces rather than as flags on one function:
//
//   trigger table   how many scatters buy how many spins
//   the counter     spins left, spins played, retriggers
//   the multiplier  one number that survives the spin that earned it
//   sticky cells    symbols that stay where they landed
//
// WHAT THIS DOES NOT DO. It does not spin anything. The board comes from your
// generator and the win from your evaluator, exactly as in the base game; this
// owns the bookkeeping between spins, which is where the arithmetic errors
// live. Everything is a multiple of bet, because math is currency-blind.

import { type Grid, type Pos, indexOf, withAt } from "@open-rgs/grid";

// --- trigger -----------------------------------------------------------------

/** Scatters landed to spins awarded: `{ 3: 10, 4: 15, 5: 25 }`.
 *
 *  A table rather than a formula, because that is how a paytable states it and
 *  how a lab reads it back. Counts with no entry award nothing. */
export type TriggerTable = Readonly<Record<number, number>>;

/** Spins a count of scatters awards, or 0 when it does not trigger.
 *
 *  Counts ABOVE the table's top entry award the top entry: landing six
 *  scatters on a table that stops at five is a better board, not a broken one,
 *  and paying it nothing is the kind of bug that only shows up on the boards
 *  players remember. */
export function spinsFor(table: TriggerTable, scatters: number): number {
  if (!Number.isInteger(scatters) || scatters < 0) return 0;
  const exact = table[scatters];
  if (exact !== undefined) return exact;
  let best = 0;
  let bestCount = -1;
  for (const [k, v] of Object.entries(table)) {
    const count = Number(k);
    if (count <= scatters && count > bestCount) { bestCount = count; best = v; }
  }
  return best;
}

/** Does this count trigger the feature at all? */
export function triggers(table: TriggerTable, scatters: number): boolean {
  return spinsFor(table, scatters) > 0;
}

/** Smallest count that awards anything. The number a tease is built around. */
export function triggerAt(table: TriggerTable): number {
  let min = Infinity;
  for (const [k, v] of Object.entries(table)) {
    const count = Number(k);
    if (v > 0 && count < min) min = count;
  }
  return Number.isFinite(min) ? min : 0;
}

// --- the multiplier that survives a spin -------------------------------------

/**
 * How the global multiplier moves.
 *
 * `steps` is read in order and the last value repeats, so `[1, 2, 3, 5]` means
 * the fourth spin and every spin after it run at 5x. `perSpin` advances one
 * step every spin; `perWin` advances only on a spin that paid, which is the
 * version that makes a dry spell hurt.
 */
export interface MultiplierLadder {
  readonly steps: readonly number[];
  readonly advance?: "per-spin" | "per-win" | "manual";
}

/** Ladder value at a 0-based index, with the last step repeating. */
export function multiplierAt(ladder: MultiplierLadder, index: number): number {
  const { steps } = ladder;
  if (steps.length === 0) return 1;
  if (index < 0) return steps[0]!;
  return steps[Math.min(index, steps.length - 1)]!;
}

// --- symbols that stay put ---------------------------------------------------

/** Cells held across spins: the sticky wild, the locked coin, the frozen
 *  symbol. Build with {@link stick} and apply to each fresh board. */
export type StickyLayer<S> = ReadonlyArray<readonly [Pos, S]>;

/** Add a held cell. A second stick on the same cell replaces it, because two
 *  symbols cannot occupy one position and silently keeping the older one is
 *  the surprising half of that. */
export function stick<S>(layer: StickyLayer<S>, pos: Pos, symbol: S): StickyLayer<S> {
  const rest = layer.filter(([p]) => !(p.col === pos.col && p.row === pos.row));
  return [...rest, [pos, symbol] as const];
}

/** Write the held cells onto a freshly drawn board. Run this on every spin,
 *  after the generator and before the evaluator, or the sticky symbol is only
 *  sticky on the spin it landed. */
export function applySticky<S>(grid: Grid<S>, layer: StickyLayer<S>): Grid<S> {
  const inside = layer.filter(([p]) => indexOf(grid.shape, p.col, p.row) >= 0);
  return inside.length === 0 ? grid : withAt(grid, inside);
}

/** How many cells are held. */
export function stuckCount<S>(layer: StickyLayer<S>): number {
  return layer.length;
}

// --- the feature -------------------------------------------------------------

export interface FreeSpinState<S = string> {
  /** Spins not yet played. */
  readonly spinsLeft: number;
  /** Spins played so far. */
  readonly spinsPlayed: number;
  /** Sum of every spin's paid win, in bet multiples, with the global
   *  multiplier already applied. */
  readonly total: number;
  /** The global multiplier as it stands now. A spin is paid at the value
   *  showing when it is played, and the ladder moves afterwards. */
  readonly multiplier: number;
  /** Position on the ladder. Kept in the state rather than derived, so what
   *  moved the multiplier is inspectable in a report. */
  readonly ladderStep: number;
  /** Times the feature retriggered, and the spins those retriggers awarded. */
  readonly retriggers: number;
  readonly retriggerSpins: number;
  /** Cells held across spins. */
  readonly sticky: StickyLayer<S>;
}

export interface FreeSpinConfig {
  /** Global multiplier behaviour. Omit for a flat 1x. */
  readonly ladder?: MultiplierLadder;
  /** Cap on the spins retriggers may award in total. A feature that can
   *  retrigger without limit is bounded only by the max-win cap, and that cap
   *  is a payout rule rather than a statement about how long a round runs. */
  readonly maxRetriggerSpins?: number;
}

/** Open a feature with a number of spins. */
export function beginFreeSpins<S = string>(spins: number, cfg: FreeSpinConfig = {}): FreeSpinState<S> {
  if (!Number.isInteger(spins) || spins < 0) {
    throw new Error(`beginFreeSpins: spins must be a non-negative integer, got ${spins}`);
  }
  return {
    spinsLeft: spins,
    spinsPlayed: 0,
    total: 0,
    multiplier: cfg.ladder ? multiplierAt(cfg.ladder, 0) : 1,
    ladderStep: 0,
    retriggers: 0,
    retriggerSpins: 0,
    sticky: [],
  };
}

/** Feature over: no spins left. */
export function isFeatureOver<S>(state: FreeSpinState<S>): boolean {
  return state.spinsLeft <= 0;
}

/**
 * Record one played spin.
 *
 * `win` is that spin's win in bet multiples BEFORE the global multiplier. This
 * applies it, which is the reason the multiplier lives in the state rather
 * than in your evaluator: a spin is paid at the value that was showing when it
 * was played, and the ladder moves afterwards. Getting that order backwards
 * pays the first spin of a feature at the second spin's multiplier, which is a
 * small mistake that compounds over the whole feature.
 */
export function playSpin<S>(
  state: FreeSpinState<S>,
  win: number,
  cfg: FreeSpinConfig = {},
): FreeSpinState<S> {
  if (!Number.isFinite(win) || win < 0) {
    throw new Error(`playSpin: win must be a non-negative number of bet multiples, got ${win}`);
  }
  if (isFeatureOver(state)) return state;

  const paid = win * state.multiplier;
  const advance = cfg.ladder?.advance ?? "per-spin";
  const step =
    cfg.ladder === undefined || advance === "manual" ? state.ladderStep
    : advance === "per-win" ? state.ladderStep + (win > 0 ? 1 : 0)
    : state.ladderStep + 1;

  return {
    ...state,
    spinsLeft: state.spinsLeft - 1,
    spinsPlayed: state.spinsPlayed + 1,
    total: state.total + paid,
    ladderStep: step,
    multiplier: cfg.ladder && advance !== "manual" ? multiplierAt(cfg.ladder, step) : state.multiplier,
  };
}

/** Award more spins mid-feature. Adds to what is left, never resets it, which
 *  is what makes a retrigger late in a feature worth more than an early one. */
export function retrigger<S>(
  state: FreeSpinState<S>,
  extra: number,
  cfg: FreeSpinConfig = {},
): FreeSpinState<S> {
  if (!Number.isInteger(extra) || extra < 0) {
    throw new Error(`retrigger: extra must be a non-negative integer, got ${extra}`);
  }
  if (extra === 0) return state;
  const cap = cfg.maxRetriggerSpins;
  const allowed = cap === undefined ? extra : Math.max(0, Math.min(extra, cap - state.retriggerSpins));
  if (allowed === 0) return state;
  return {
    ...state,
    spinsLeft: state.spinsLeft + allowed,
    retriggers: state.retriggers + 1,
    retriggerSpins: state.retriggerSpins + allowed,
  };
}

/** Move the global multiplier by hand: a ladder set to `manual`, or a symbol
 *  that bumps it. Never below zero. */
export function bumpMultiplier<S>(state: FreeSpinState<S>, by: number): FreeSpinState<S> {
  if (!Number.isFinite(by)) throw new Error(`bumpMultiplier: by must be finite, got ${by}`);
  return { ...state, multiplier: Math.max(0, state.multiplier + by) };
}

/** Set the global multiplier outright. */
export function setMultiplier<S>(state: FreeSpinState<S>, to: number): FreeSpinState<S> {
  if (!Number.isFinite(to) || to < 0) {
    throw new Error(`setMultiplier: to must be a non-negative number, got ${to}`);
  }
  return { ...state, multiplier: to };
}

/** Hold a cell for the rest of the feature. */
export function stickCell<S>(state: FreeSpinState<S>, pos: Pos, symbol: S): FreeSpinState<S> {
  return { ...state, sticky: stick(state.sticky, pos, symbol) };
}

// --- the loop ----------------------------------------------------------------

/** What one free spin produced. Everything is optional except the win, because
 *  most spins are just a win. */
export interface SpinOutcome<S = string> {
  /** This spin's win in bet multiples, before the global multiplier. */
  readonly win: number;
  /** Scatters landed again: spins to add. */
  readonly retrigger?: number;
  /** Cells to hold for the rest of the feature. */
  readonly stick?: ReadonlyArray<readonly [Pos, S]>;
  /** Move the global multiplier, for a `manual` ladder. */
  readonly bump?: number;
}

export interface RunOptions {
  /** Hard stop, so a retrigger rule that always fires cannot hang a round.
   *  Default 500. This is not the payout cap, which is the engine's job. */
  readonly maxSpins?: number;
}

/**
 * Run a feature to its end.
 *
 * `spin` plays one spin: draw a board, apply the sticky layer, evaluate, and
 * report what happened. Order inside this loop is the part worth reading: the
 * win is paid at the multiplier showing when the spin was played, then a
 * retrigger extends the feature, then held cells are added for the spins that
 * follow.
 */
export function runFreeSpins<S = string>(
  start: FreeSpinState<S>,
  spin: (state: FreeSpinState<S>, next: () => number) => SpinOutcome<S>,
  next: () => number,
  cfg: FreeSpinConfig = {},
  opts: RunOptions = {},
): FreeSpinState<S> {
  const maxSpins = opts.maxSpins ?? 500;
  let state = start;
  while (!isFeatureOver(state) && state.spinsPlayed < maxSpins) {
    const outcome = spin(state, next);
    state = playSpin(state, outcome.win, cfg);
    if (outcome.retrigger) state = retrigger(state, outcome.retrigger, cfg);
    if (outcome.bump) state = bumpMultiplier(state, outcome.bump);
    for (const [pos, symbol] of outcome.stick ?? []) state = stickCell(state, pos, symbol);
  }
  return state;
}
