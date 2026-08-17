// @open-rgs/pay-ways - ways / multiways.
//
// No paylines. A symbol pays if it appears on consecutive columns starting at
// column 0, and the payout is multiplied by the number of DISTINCT PATHS
// through those columns - the product of how many copies each column holds.
//
//     reel 0: 2 HIGH    reel 1: 3 HIGH    reel 2: 1 HIGH
//     -> 2 x 3 x 1 = 6 ways of three-of-a-kind
//
// "1024 ways" is just 4^5; "243 ways" is 3^5. The number is a consequence of
// the grid, not a setting.
//
// TWO THINGS THAT COST MONEY IF YOU GET THEM WRONG:
//
//   1. The run must be CONTIGUOUS from column 0. A gap ends it. Counting every
//      column the symbol appears on, gap or not, inflates both the count and
//      the ways multiplier.
//
//   2. Each symbol pays at most ONCE, for its longest run - the same rule as
//      paylines. Ways games are dense, so a prefix-paying bug here is far
//      worse than on lines: nearly every spin would win.

import { type Grid, heightOf, indexOf, widthOf } from "@open-rgs/grid";
import { type Paytable, type Roles, type Win, isScatter, substitutes } from "@open-rgs/paytable";

export interface WaysOptions<S = string> {
  readonly roles?: Roles<S>;
}

/** Cells in `col` whose symbol counts toward `target`, wilds included. */
function matchesInColumn<S>(grid: Grid<S>, col: number, target: S, roles: Roles<S>): number[] {
  const out: number[] = [];
  for (let row = 0; row < heightOf(grid.shape, col); row++) {
    const i = indexOf(grid.shape, col, row);
    if (substitutes(grid.cells[i]!, target, roles)) out.push(i);
  }
  return out;
}

/**
 * Evaluate one symbol across the grid.
 *
 * Walks columns from 0 while the symbol keeps appearing, multiplying the
 * per-column counts. Stops at the first column with none - that gap is what
 * makes the run finite.
 */
export function evalWay<S>(
  grid: Grid<S>,
  symbol: S,
  pay: Paytable<S>,
  opts: WaysOptions<S> = {},
): Win<S> | undefined {
  const roles = opts.roles ?? {};
  // Scatters pay on total count anywhere, which is a different evaluator.
  if (isScatter(symbol, roles)) return undefined;

  let ways = 1;
  let columns = 0;
  const positions: number[] = [];

  for (let col = 0; col < widthOf(grid.shape); col++) {
    const hits = matchesInColumn(grid, col, symbol, roles);
    if (hits.length === 0) break; // the gap ends the run
    ways *= hits.length;
    columns++;
    positions.push(...hits);
  }

  if (columns === 0) return undefined;
  const base = pay.pay(symbol, columns);
  if (base <= 0) return undefined;

  return { symbol, count: columns, multiplier: base * ways, positions, ways };
}

/**
 * Evaluate every paying symbol.
 *
 * Each symbol contributes at most one win, so a board where HIGH runs four
 * columns pays 4-of-a-kind once - not 3-of-a-kind as well.
 */
export function evalWays<S extends string>(
  grid: Grid<S>,
  pay: Paytable<S>,
  opts: WaysOptions<S> = {},
): Win<S>[] {
  const roles = opts.roles ?? {};
  const wins: Win<S>[] = [];
  for (const symbol of pay.symbols) {
    if (isScatter(symbol, roles)) continue;
    const w = evalWay(grid, symbol, pay, opts);
    if (w) wins.push(w);
  }
  return wins;
}

/** Total ways a grid offers - the "1024 ways" on the marketing. Product of the
 *  column heights, so a ragged grid reports its own real number. */
export function totalWays<S>(grid: Grid<S>): number {
  let n = 1;
  for (const h of grid.shape) n *= h;
  return n;
}
