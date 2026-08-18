// @open-rgs/pay-cluster - cluster pays.
//
// A win is a group of the same symbol connected ORTHOGONALLY (up, down, left,
// right - never diagonally), paid by how many cells the group holds. Flood
// fill from each unvisited cell.
//
// Wilds are the whole difficulty. A wild belongs to every cluster it touches,
// so it is not enough to flood-fill once and mark cells visited: a wild sitting
// between a HIGH cluster and a LOW cluster is legitimately part of both, and
// consuming it for the first one silently shrinks the second.
//
// So the fill runs PER SYMBOL, and only non-wild cells are consumed. A wild can
// be reached again by the next symbol's fill, which is the behaviour players
// and paytables assume.
//
// A wild-only region pays nothing on its own: with no real symbol to be, there
// is no paytable row to read, and inventing one would mean a board of pure
// wilds paid something arbitrary.

import { type Grid, type Pos, indexOf, neighbours, positions } from "@open-rgs/grid";
import { type Paytable, type Roles, type Win, isScatter, isWild, substitutes } from "@open-rgs/paytable";

export interface ClusterOptions<S = string> {
  readonly roles?: Roles<S>;
  /** Smallest cluster worth reporting. Defaults to the paytable's own minimum
   *  for the symbol, which is usually what you want. */
  readonly minSize?: number;
}

function symbolAt<S>(grid: Grid<S>, p: Pos): S {
  return grid.cells[indexOf(grid.shape, p.col, p.row)]!;
}

/**
 * Every cluster of `symbol`, as lists of flat indices.
 *
 * Wilds join the cluster but are never consumed, so a later symbol's fill can
 * still reach them.
 */
export function clustersOf<S>(grid: Grid<S>, symbol: S, roles: Roles<S> = {}): number[][] {
  const seen = new Set<number>();
  const out: number[][] = [];

  for (const start of positions(grid.shape)) {
    const startIndex = indexOf(grid.shape, start.col, start.row);
    if (seen.has(startIndex)) continue;
    // Seed only from a REAL occurrence. Starting from a wild would grow a
    // cluster around a symbol that is not actually present.
    if (symbolAt(grid, start) !== symbol) continue;

    const group: number[] = [];
    const stack: Pos[] = [start];
    const local = new Set<number>([startIndex]);

    while (stack.length > 0) {
      const p = stack.pop()!;
      const i = indexOf(grid.shape, p.col, p.row);
      group.push(i);
      // Only real matches are consumed globally; a wild stays available to the
      // next symbol's fill, because it genuinely belongs to both clusters.
      if (symbolAt(grid, p) === symbol) seen.add(i);

      for (const n of neighbours(grid.shape, p)) {
        const ni = indexOf(grid.shape, n.col, n.row);
        if (local.has(ni)) continue;
        if (!substitutes(symbolAt(grid, n), symbol, roles)) continue;
        local.add(ni);
        stack.push(n);
      }
    }
    out.push(group);
  }
  return out;
}

/** Evaluate one symbol's clusters. */
export function evalClusters<S>(
  grid: Grid<S>,
  symbol: S,
  pay: Paytable<S>,
  opts: ClusterOptions<S> = {},
): Win<S>[] {
  const roles = opts.roles ?? {};
  // A scatter pays on total count, not on adjacency; a wild has no paytable
  // identity of its own here.
  if (isScatter(symbol, roles) || isWild(symbol, roles)) return [];

  const min = opts.minSize ?? pay.minCount(symbol);
  const wins: Win<S>[] = [];
  for (const group of clustersOf(grid, symbol, roles)) {
    if (min > 0 && group.length < min) continue;
    const multiplier = pay.pay(symbol, group.length);
    if (multiplier <= 0) continue;
    wins.push({ symbol, count: group.length, multiplier, positions: group });
  }
  return wins;
}

/** Evaluate every paying symbol's clusters. */
export function evalAllClusters<S extends string>(
  grid: Grid<S>,
  pay: Paytable<S>,
  opts: ClusterOptions<S> = {},
): Win<S>[] {
  const wins: Win<S>[] = [];
  for (const symbol of pay.symbols) wins.push(...evalClusters(grid, symbol, pay, opts));
  return wins;
}

/** Largest cluster of `symbol`, 0 if none. */
export function largestCluster<S>(grid: Grid<S>, symbol: S, roles: Roles<S> = {}): number {
  let max = 0;
  for (const g of clustersOf(grid, symbol, roles)) if (g.length > max) max = g.length;
  return max;
}
