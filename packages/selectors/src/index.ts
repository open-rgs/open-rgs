// @open-rgs/selectors - "which cells?"
//
// Two features that look unrelated turn out to need the same primitive.
//
//   A placement directive:  "put 3 HIGH symbols somewhere on reels 0-2"
//   A hold-and-win effect:  "collect every coin INTO that collector"
//
// Both are (pick some positions) then (do something to them). Only the first
// half varies, so it lives here once and both features compose against it.
//
// A Selector is a function of (grid, next) -> positions. It takes the rng
// rather than owning one, so a selection is reproducible from a seed and a
// caller threading host.rng_next gets the same cells on a replay.
//
// ORDER IS STABLE. Every selector returns positions in column-major order
// (except `randomN`/`upTo`, which return draw order). A selector that returned
// positions in set-iteration order would make a seeded replay diverge between
// engine versions, which is the kind of bug that only shows up in a
// certification rerun.

import {
  type Grid, type Pos, type Shape,
  heightOf, indexOf, positions, positionsWhere, samePos, widthOf,
} from "@open-rgs/grid";

/** Picks cells from a grid. `next` supplies floats in [0, 1) - always
 *  `host.rng_next` in real math. */
export type Selector<S = string> = (grid: Grid<S>, next: () => number) => Pos[];

/** Every cell. */
export function all<S>(): Selector<S> {
  return (grid) => positions(grid.shape);
}

/** Nothing. Useful as an identity when composing conditionally. */
export function none<S>(): Selector<S> {
  return () => [];
}

/** Every cell in the given columns, in column order. Out-of-range columns are
 *  ignored rather than throwing - a directive written for a 6-reel set should
 *  degrade on a 5-reel one, not crash mid-spin. */
export function cols<S>(list: readonly number[]): Selector<S> {
  return (grid) => {
    const wanted = new Set(list);
    const out: Pos[] = [];
    for (let col = 0; col < widthOf(grid.shape); col++) {
      if (!wanted.has(col)) continue;
      for (let row = 0; row < heightOf(grid.shape, col); row++) out.push({ col, row });
    }
    return out;
  };
}

/** Every cell in one column. */
export function col<S>(n: number): Selector<S> {
  return cols([n]);
}

/** Every cell in the given rows. On a ragged grid a row may not exist in every
 *  column; those cells are simply absent. */
export function rows<S>(list: readonly number[]): Selector<S> {
  return (grid) => {
    const wanted = new Set(list);
    const out: Pos[] = [];
    for (let c = 0; c < widthOf(grid.shape); c++) {
      for (let r = 0; r < heightOf(grid.shape, c); r++) {
        if (wanted.has(r)) out.push({ col: c, row: r });
      }
    }
    return out;
  };
}

/** Cells whose symbol and position satisfy a predicate. */
export function where<S>(match: (s: S, pos: Pos) => boolean): Selector<S> {
  return (grid) => positionsWhere(grid, match);
}

/** Cells holding exactly this symbol. */
export function holding<S>(symbol: S): Selector<S> {
  return where<S>((s) => s === symbol);
}

/** Cells holding any of these symbols - "the high symbols", "any coin". */
export function holdingAny<S>(symbols: readonly S[]): Selector<S> {
  const set = new Set(symbols);
  return where<S>((s) => set.has(s));
}

/** One specific cell, if it exists on this grid. The `self` of a hold-and-win
 *  effect. */
export function at<S>(pos: Pos): Selector<S> {
  return (grid) => (indexOf(grid.shape, pos.col, pos.row) >= 0 ? [pos] : []);
}

/** Everything except one cell - the `others` of "collect every coin into that
 *  collector". */
export function others<S>(pos: Pos): Selector<S> {
  return (grid) => positions(grid.shape).filter((p) => !samePos(p, pos));
}

/** Cells in either selection, de-duplicated, in column-major order. */
export function union<S>(...parts: ReadonlyArray<Selector<S>>): Selector<S> {
  return (grid, next) => {
    const keep = new Set<number>();
    for (const part of parts) {
      for (const p of part(grid, next)) keep.add(indexOf(grid.shape, p.col, p.row));
    }
    return positions(grid.shape).filter((p) => keep.has(indexOf(grid.shape, p.col, p.row)));
  };
}

/** Cells in every selection. */
export function intersect<S>(a: Selector<S>, b: Selector<S>): Selector<S> {
  return (grid, next) => {
    const inB = new Set(b(grid, next).map((p) => indexOf(grid.shape, p.col, p.row)));
    return a(grid, next).filter((p) => inB.has(indexOf(grid.shape, p.col, p.row)));
  };
}

/** Cells in `a` but not `b`. */
export function except<S>(a: Selector<S>, b: Selector<S>): Selector<S> {
  return (grid, next) => {
    const inB = new Set(b(grid, next).map((p) => indexOf(grid.shape, p.col, p.row)));
    return a(grid, next).filter((p) => !inB.has(indexOf(grid.shape, p.col, p.row)));
  };
}

/** Cells NOT in the selection. */
export function not<S>(sel: Selector<S>): Selector<S> {
  return except(all<S>(), sel);
}

/**
 * Exactly `n` distinct cells drawn uniformly from `from`, without replacement.
 *
 * THROWS when `from` yields fewer than `n`. That is deliberate and matches
 * `pickDistinct` in @open-rgs/weights: a placement directive has already priced
 * "3 high symbols" into its RTP, so quietly placing 2 would corrupt the model
 * with nothing to notice it. Use {@link upTo} where a short draw is genuinely
 * acceptable.
 *
 * Consumes one `next()` per cell drawn. Returns draw order, not grid order -
 * callers that place different symbols per slot depend on which came first.
 */
export function randomN<S>(n: number, from: Selector<S> = all<S>()): Selector<S> {
  if (!Number.isInteger(n) || n < 0) throw new Error(`randomN: n must be a non-negative integer, got ${n}`);
  return (grid, next) => {
    const pool = from(grid, next);
    if (pool.length < n) {
      throw new Error(`randomN: asked for ${n} cells but the selection yields only ${pool.length}`);
    }
    return drawWithoutReplacement(pool, n, next);
  };
}

/** Up to `n` cells - takes everything available when the selection is short.
 *  The forgiving twin of {@link randomN}, for effects whose payout scales with
 *  however many cells they actually found. */
export function upTo<S>(n: number, from: Selector<S> = all<S>()): Selector<S> {
  if (!Number.isInteger(n) || n < 0) throw new Error(`upTo: n must be a non-negative integer, got ${n}`);
  return (grid, next) => {
    const pool = from(grid, next);
    return drawWithoutReplacement(pool, Math.min(n, pool.length), next);
  };
}

/** A single random cell from the selection, or none when it is empty. */
export function oneOf<S>(from: Selector<S> = all<S>()): Selector<S> {
  return upTo(1, from);
}

/** Partial Fisher-Yates: draws `count` items uniformly without replacement in
 *  O(count), consuming exactly one `next()` per item. */
function drawWithoutReplacement(pool: readonly Pos[], count: number, next: () => number): Pos[] {
  const rest = pool.slice();
  const out: Pos[] = [];
  for (let i = 0; i < count; i++) {
    const span = rest.length - i;
    // Clamp so an rng returning exactly 1 cannot index past the end.
    let j = i + Math.floor(next() * span);
    if (j >= rest.length) j = rest.length - 1;
    const picked = rest[j]!;
    rest[j] = rest[i]!;
    rest[i] = picked;
    out.push(picked);
  }
  return out;
}

/** How many cells a selector yields, without caring which. */
export function countSelected<S>(sel: Selector<S>, grid: Grid<S>, next: () => number): number {
  return sel(grid, next).length;
}

/** Every position of a shape, for callers that have a shape but no grid yet. */
export function positionsOfShape(shape: Shape): Pos[] {
  return positions(shape);
}
