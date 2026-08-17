// @open-rgs/recipes - a board is drawn from a MIXTURE of named recipes, each
// with a declared probability.
//
// WHY NOT JUST DECORATE A BOARD AFTER DRAWING IT. Because the moment you take
// a drawn grid and stamp extra symbols onto it "for feel", the board's real
// distribution stops matching the one your RTP was computed from, and nothing
// tells you. Worse, if what you are stamping on is a tease, you have built the
// thing regulators specifically prohibit: showing near-wins more often than the
// underlying maths produces them (GLI-11; Nevada Reg 14).
//
// A mixture avoids both by construction:
//
//   - Every board comes from exactly one declared recipe.
//   - RTP is sum over recipes of p_i * RTP(recipe_i) - each independently
//     measurable, and each recipe's contribution reportable on its own.
//   - A tease recipe is a REAL draw that really goes through the pay
//     evaluator. It biases WHICH boards appear, at a rate you wrote down. It
//     never fakes an outcome.
//
// So "how often does a player see two scatters and no third?" becomes a number
// you can measure and defend, rather than an emergent property of decoration.

import { type Grid, type Pos, type Shape, withAt } from "@open-rgs/grid";
import { type Selector } from "@open-rgs/selectors";
import { type Sampler } from "@open-rgs/weights";

/** Produces a grid from a stream of floats in [0, 1). */
export type Generator<S = string> = (next: () => number) => Grid<S>;

/** One named way a board can come about. */
export interface Recipe<S = string> {
  /** Unique, and used as the reporting key - it will show up in RTP
   *  contribution tables, so name it after what a player would see. */
  readonly name: string;
  /** Probability this recipe is chosen. All recipes must sum to 1. */
  readonly p: number;
  readonly draw: Generator<S>;
}

/** A board, plus which recipe produced it - so a simulator can attribute
 *  outcomes without guessing. */
export interface Draw<S = string> {
  readonly grid: Grid<S>;
  readonly recipe: string;
}

export interface Mixture<S = string> {
  /** Draw a board. Consumes one float to select the recipe, then whatever the
   *  chosen recipe consumes. */
  (next: () => number): Draw<S>;
  readonly recipes: ReadonlyArray<Recipe<S>>;
  /** Declared probability of a recipe, 0 if unknown. The analytic weight in
   *  `RTP = sum p_i * RTP_i`. */
  probabilityOf(name: string): number;
}

/**
 * Build a mixture.
 *
 * Probabilities must sum to 1 within a small tolerance. That is not
 * fussiness: a mixture summing to 0.98 silently drops 2% of spins onto
 * whichever recipe the rounding happens to land on, and the RTP you computed
 * from the declared weights is wrong by an amount nobody will notice.
 */
export function recipes<S>(list: ReadonlyArray<Recipe<S>>): Mixture<S> {
  if (list.length === 0) throw new Error("recipes: needs at least one recipe");

  const seen = new Set<string>();
  let total = 0;
  for (const r of list) {
    if (seen.has(r.name)) throw new Error(`recipes: duplicate recipe name '${r.name}'`);
    seen.add(r.name);
    if (!Number.isFinite(r.p) || r.p < 0) {
      throw new Error(`recipes: recipe '${r.name}' has an invalid probability (${r.p})`);
    }
    total += r.p;
  }
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(
      `recipes: probabilities must sum to 1, got ${total}. ` +
        `A mixture that does not sum to 1 silently misprices every spin.`,
    );
  }

  // Cumulative bounds, same shape as a weighted draw.
  const bounds: number[] = [];
  let acc = 0;
  for (const r of list) { acc += r.p; bounds.push(acc); }

  const draw = ((next: () => number): Draw<S> => {
    const r = next();
    const x = r <= 0 ? 0 : r >= 1 ? 1 : r;
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bounds[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    // A zero-probability recipe must be unreachable at every r, including the
    // very top of the range where the cumulative table has gone flat.
    if (list[lo]!.p === 0) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.p > 0) { lo = i; break; }
    }
    const chosen = list[lo]!;
    return { grid: chosen.draw(next), recipe: chosen.name };
  }) as Mixture<S>;

  Object.defineProperty(draw, "recipes", { value: list, enumerable: true });
  Object.defineProperty(draw, "probabilityOf", {
    value: (name: string) => list.find((r) => r.name === name)?.p ?? 0,
    enumerable: true,
  });
  return draw;
}

// --- placement, the building blocks a sub-recipe is made of -----------------
//
// Each of these takes a base generator and returns a new one. They compose, so
// a recipe is written as a pipeline rather than as a special case inside the
// base draw.

/** Write `symbol` into every cell the selector picks. */
export function placeAt<S>(symbol: S, where: Selector<S>, base: Generator<S>): Generator<S> {
  return (next) => {
    const grid = base(next);
    const cells = where(grid, next);
    return withAt(grid, cells.map((p) => [p, symbol] as const));
  };
}

/** Put exactly `n` of `symbol` somewhere in the selection.
 *
 *  Uses the selector's own draw, so it inherits `randomN`'s refusal to
 *  under-deliver: a recipe that declared 3 symbols and quietly placed 2 would
 *  be mispriced against its own name. */
export function place<S>(n: number, symbol: S, where: Selector<S>, base: Generator<S>): Generator<S> {
  return (next) => {
    const grid = base(next);
    const pool = where(grid, next);
    if (pool.length < n) {
      throw new Error(`place: recipe wants ${n} cells for '${String(symbol)}' but the selection yields ${pool.length}`);
    }
    return withAt(grid, pool.slice(0, n).map((p) => [p, symbol] as const));
  };
}

/** Fill an entire column with one symbol - a full stack. */
export function stack<S>(symbol: S, colIndex: number, base: Generator<S>): Generator<S> {
  return (next) => {
    const grid = base(next);
    const writes: Array<readonly [Pos, S]> = [];
    const h = grid.shape[colIndex] ?? 0;
    for (let row = 0; row < h; row++) writes.push([{ col: colIndex, row }, symbol]);
    return withAt(grid, writes);
  };
}

/** Draw the symbol to place, rather than fixing it - "place 3 HIGH symbols"
 *  where HIGH is itself a weighted choice among the high-paying set. */
export function placeDrawn<S>(n: number, from: Sampler<S>, where: Selector<S>, base: Generator<S>): Generator<S> {
  return (next) => {
    const grid = base(next);
    const pool = where(grid, next);
    if (pool.length < n) {
      throw new Error(`placeDrawn: recipe wants ${n} cells but the selection yields ${pool.length}`);
    }
    return withAt(grid, pool.slice(0, n).map((p) => [p, from.pick(next())] as const));
  };
}

/** A generator that always returns the same board. Useful for pinning a recipe
 *  in a test, and for a deterministic feature board. */
export function fixed<S>(grid: Grid<S>): Generator<S> {
  return () => grid;
}

/** Expected rate of a recipe over `spins` - the analytic count a measured
 *  frequency is checked against. */
export function expectedRate<S>(m: Mixture<S>, name: string, spins: number): number {
  return m.probabilityOf(name) * spins;
}

/** Shape helper so a recipe list can be declared before any grid exists. */
export type { Shape };
