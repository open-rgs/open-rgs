// @open-rgs/cascade - tumble mechanics.
//
// One step is: clear the winning cells, let what is left fall, refill the gaps
// from the top, evaluate again. Repeat while something keeps winning, usually
// with a multiplier that climbs each step.
//
// Four things that are easy to get wrong:
//
//   1. Gravity is PER COLUMN. On a ragged grid a short reel drops its symbols
//      a shorter distance, and treating the board as a rectangle mixes symbols
//      between columns - a bug that looks like a shuffle rather than a fall.
//
//   2. Overlapping wins share cells. Two paylines crossing the same symbol
//      must clear it once; counting it twice makes the refill draw more
//      symbols than there are holes, and the board drifts.
//
//   3. The loop must be bounded. A refill can always produce another win, so
//      in principle a cascade never ends. Unbounded, one unlucky spin hangs
//      the server; the cap turns that into a finite, auditable round.
//
//   4. The multiplier ladder applies to the step's OWN win, not retroactively
//      to what earlier steps already paid. Applying it to the running total
//      compounds and inflates RTP dramatically.
//
// Nothing here evaluates wins - the caller passes its evaluator in, so the
// same cascade drives lines, ways, or clusters without knowing which.

import { type Grid, type Shape, heightOf, indexOf, widthOf } from "@open-rgs/grid";

/** A board mid-cascade: `null` is a hole waiting to be filled. */
export type Holed<S> = Grid<S | null>;

/** What the caller's evaluator must return. Matches the `Win` shape the
 *  pay-* packages produce, so `{ multiplier, positions }` can be built by
 *  summing wins and concatenating their positions. */
export interface Evaluation {
  readonly multiplier: number;
  /** Flat grid indices that won. Duplicates are fine - they are de-duplicated
   *  here, because two crossing paylines legitimately share a cell. */
  readonly positions: readonly number[];
}

/** Punch holes in a board. Duplicate indices collapse to one hole. */
export function clear<S>(grid: Grid<S>, positions: readonly number[]): Holed<S> {
  const holes = new Set(positions);
  return {
    shape: grid.shape,
    cells: grid.cells.map((s, i) => (holes.has(i) ? null : s)),
  };
}

/**
 * Apply gravity: within each column, symbols fall to the bottom and holes rise
 * to the top.
 *
 * Row 0 is the TOP of a column, so falling means moving toward higher row
 * indices, and after this the holes occupy the lowest indices.
 */
export function collapse<S>(grid: Holed<S>): Holed<S> {
  const cells: (S | null)[] = [];
  for (let col = 0; col < widthOf(grid.shape); col++) {
    const h = heightOf(grid.shape, col);
    const kept: (S | null)[] = [];
    for (let row = 0; row < h; row++) {
      const v = grid.cells[indexOf(grid.shape, col, row)]!;
      if (v !== null) kept.push(v);
    }
    // Holes at the top, survivors below, order preserved.
    const holes = h - kept.length;
    for (let i = 0; i < holes; i++) cells.push(null);
    for (const v of kept) cells.push(v);
  }
  return { shape: grid.shape, cells };
}

/**
 * Fill every hole from `pick`.
 *
 * Draws in column-major, top-to-bottom order - the same order everything else
 * in these libraries walks a grid - so a seeded replay refills identically.
 */
export function refill<S>(grid: Holed<S>, pick: (next: () => number) => S, next: () => number): Grid<S> {
  const cells: S[] = [];
  for (let i = 0; i < grid.cells.length; i++) {
    const v = grid.cells[i]!;
    cells.push(v === null ? pick(next) : v);
  }
  return { shape: grid.shape, cells };
}

// --- where the new symbols come from ----------------------------------------
//
// `refill` takes a `pick`, and what you hand it is a real decision. Three
// shapes cover it, and the third is the one games get wrong.

/** Refill every hole from one set: the plain case. */
export function refillFrom<S>(set: { pick(r: number): S }): (next: () => number) => S {
  return (next) => set.pick(next());
}

/**
 * Refill each column from its own set.
 *
 * The reason to bother: a cascade that refills every column from the base
 * game's single set quietly flattens a game whose columns differ, which is
 * most games with a premium-light first reel. Columns past the end of the list
 * reuse the last set.
 */
export function refillPerColumn<S>(
  grid: Holed<S>,
  sets: ReadonlyArray<{ pick(r: number): S }>,
  next: () => number,
): Grid<S> {
  if (sets.length === 0) throw new Error("refillPerColumn: needs at least one set");
  const cells: S[] = [];
  let i = 0;
  for (let col = 0; col < widthOf(grid.shape); col++) {
    const set = sets[Math.min(col, sets.length - 1)]!;
    const h = heightOf(grid.shape, col);
    for (let row = 0; row < h; row++, i++) {
      const v = grid.cells[i]!;
      cells.push(v === null ? set.pick(next()) : v);
    }
  }
  return { shape: grid.shape, cells };
}

/**
 * Refill, then reject boards that would win immediately, up to `attempts`.
 *
 * Sometimes wanted for presentation ("no instant re-win"), and it is worth
 * being blunt about the cost: rejection sampling CHANGES THE DISTRIBUTION. The
 * refilled cells are no longer drawn from your set, they are drawn from your
 * set conditioned on not winning, which lowers the RTP of the cascade by an
 * amount that depends on the paytable. Measure the game with it on. It is here
 * because games ship it either way, and doing it by hand tends to lose the
 * attempt cap, which is the part that keeps a spin finite.
 */
export function refillAvoiding<S>(
  grid: Holed<S>,
  pick: (next: () => number) => S,
  next: () => number,
  wouldWin: (candidate: Grid<S>) => boolean,
  attempts = 8,
): { grid: Grid<S>; rejected: number } {
  let rejected = 0;
  let last = refill(grid, pick, next);
  for (let i = 0; i < attempts; i++) {
    if (!wouldWin(last)) return { grid: last, rejected };
    rejected++;
    last = refill(grid, pick, next);
  }
  // Out of attempts: take the board. A spin that cannot finish is worse than a
  // board that pays twice in a row.
  return { grid: last, rejected };
}

/** How many holes a board has. */
export function holeCount<S>(grid: Holed<S>): number {
  let n = 0;
  for (const c of grid.cells) if (c === null) n++;
  return n;
}

/** One clear-collapse-refill move, as a single call. */
export function tumble<S>(
  grid: Grid<S>,
  positions: readonly number[],
  pick: (next: () => number) => S,
  next: () => number,
): Grid<S> {
  return refill(collapse(clear(grid, positions)), pick, next);
}

export interface CascadeStep<S> {
  /** 1-based index of this step. */
  readonly step: number;
  /** The board as it stood when this step was evaluated. */
  readonly grid: Grid<S>;
  /** Cells cleared, de-duplicated. */
  readonly cleared: readonly number[];
  /** Flat indices holding a symbol that fell in from the top on this step.
   *  Not the same as `cleared`: gravity moves survivors down, so the holes
   *  that get refilled are at the TOP of each column that lost anything,
   *  wherever the clears happened to be. A client animating a drop needs
   *  these, and so does any mechanic that only counts new symbols. */
  readonly refilled: readonly number[];
  /** Base win for this step, before the ladder. */
  readonly baseMultiplier: number;
  /** Ladder value applied to this step. */
  readonly stepMultiplier: number;
  /** `baseMultiplier * stepMultiplier` - what this step actually paid. */
  readonly paid: number;
}

export interface CascadeResult<S> {
  readonly steps: readonly CascadeStep<S>[];
  /** The board once nothing more wins. */
  readonly finalGrid: Grid<S>;
  /** Sum of every step's payout. */
  readonly multiplier: number;
  /** True when the run used its whole `maxSteps` budget.
   *
   *  Read it as "this cascade reached the cap", not as "this cascade had more
   *  to give": the loop stops BEFORE evaluating the step after the last one, so
   *  it cannot know whether the next board would have won. A game that sees
   *  this in simulation has a cap that is too low, or a paytable that
   *  self-sustains - either way the run is worth looking at. */
  readonly truncated: boolean;
}

export interface CascadeOptions {
  /** Multiplier for each step, in order; the last value repeats for any
   *  further steps. `[1, 2, 3, 5]` is the common shape. Defaults to a flat 1.
   *
   *  Applies to the step's OWN win only. Applying it to the running total
   *  compounds across steps and inflates RTP badly. */
  readonly stepMultipliers?: readonly number[];
  /** Hard cap on steps. A refill can always produce another win, so without a
   *  bound one unlucky spin hangs the process. Default 50. */
  readonly maxSteps?: number;
}

/** Ladder value for a 1-based step, with the final entry repeating. */
export function multiplierForStep(step: number, ladder: readonly number[]): number {
  if (ladder.length === 0) return 1;
  return ladder[Math.min(step, ladder.length) - 1]!;
}

/**
 * Run a cascade to completion.
 *
 * `evaluate` is the caller's own win logic - lines, ways or clusters. It is
 * called once per board, and the cascade stops as soon as it reports no
 * positions. A step that reports a multiplier but no positions also stops:
 * clearing nothing would refill nothing and the next board would be identical,
 * which is an infinite loop rather than a win.
 */
export function runCascade<S>(
  start: Grid<S>,
  evaluate: (grid: Grid<S>) => Evaluation,
  pick: (next: () => number) => S,
  next: () => number,
  opts: CascadeOptions = {},
): CascadeResult<S> {
  const ladder = opts.stepMultipliers ?? [1];
  const maxSteps = opts.maxSteps ?? 50;

  const steps: CascadeStep<S>[] = [];
  let grid = start;
  let total = 0;
  let truncated = false;

  for (let step = 1; ; step++) {
    if (step > maxSteps) { truncated = true; break; }

    const { multiplier: base, positions } = evaluate(grid);
    const cleared = [...new Set(positions)];
    // No cells to clear means the board cannot change - stop, whatever the
    // reported multiplier says.
    if (cleared.length === 0) break;

    const stepMultiplier = multiplierForStep(step, ladder);
    const paid = base * stepMultiplier;
    total += paid;

    // Where the fresh symbols land: the holes after gravity, which is the top
    // of every column that lost a cell.
    const holed = collapse(clear(grid, cleared));
    const refilled: number[] = [];
    for (let i = 0; i < holed.cells.length; i++) if (holed.cells[i] === null) refilled.push(i);

    steps.push({ step, grid, cleared, refilled, baseMultiplier: base, stepMultiplier, paid });

    grid = refill(holed, pick, next);
  }

  return { steps, finalGrid: grid, multiplier: total, truncated };
}

/** Shape passthrough, so a caller can declare a ladder before any grid exists. */
export type { Shape };
