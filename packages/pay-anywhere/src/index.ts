// @open-rgs/pay-anywhere - scatter pays.
//
// The simplest evaluator and the one with the largest effect on a game's shape:
// this is almost always what triggers the feature, and feature frequency is
// usually the single biggest term in RTP. Count the symbol anywhere on the
// grid, look up the paytable, done.
//
// The one rule that matters: a WILD DOES NOT COUNT. Scatter substitution would
// manufacture triggers, and the trigger rate you balanced would not be the
// trigger rate you shipped. `substitutes()` in @open-rgs/paytable already
// refuses it; this package never asks.

import { type Grid, countWhere, positionsWhere, indexOf } from "@open-rgs/grid";
import { type Paytable, type Roles, type Win } from "@open-rgs/paytable";

export interface AnywhereOptions<S = string> {
  readonly roles?: Roles<S>;
}

/** How many of `symbol` are on the grid, counting only literal matches. */
export function countAnywhere<S>(grid: Grid<S>, symbol: S): number {
  return countWhere(grid, (s) => s === symbol);
}

/**
 * Pay one symbol on its total count.
 *
 * Only literal matches count - never a wild. That is the whole safety property
 * of this evaluator.
 */
export function evalAnywhere<S>(
  grid: Grid<S>,
  symbol: S,
  pay: Paytable<S>,
): Win<S> | undefined {
  const cells = positionsWhere(grid, (s) => s === symbol);
  if (cells.length === 0) return undefined;
  const multiplier = pay.pay(symbol, cells.length);
  if (multiplier <= 0) return undefined;
  return {
    symbol,
    count: cells.length,
    multiplier,
    positions: cells.map((p) => indexOf(grid.shape, p.col, p.row)),
  };
}

/** Pay every declared scatter. */
export function evalScatters<S extends string>(
  grid: Grid<S>,
  pay: Paytable<S>,
  opts: AnywhereOptions<S> = {},
): Win<S>[] {
  const scatters = opts.roles?.scatters ?? [];
  const wins: Win<S>[] = [];
  for (const symbol of scatters) {
    const w = evalAnywhere(grid, symbol, pay);
    if (w) wins.push(w);
  }
  return wins;
}

/**
 * Does the grid hold enough of `symbol` to trigger a feature?
 *
 * Separate from paying, because a trigger and a payout are different questions:
 * plenty of games trigger on 3 scatters while paying nothing for them, and
 * plenty pay for 2 without triggering.
 */
export function triggersOn<S>(grid: Grid<S>, symbol: S, minCount: number): boolean {
  return countAnywhere(grid, symbol) >= minCount;
}

/** How many more are needed to trigger - zero once it has. The number a tease
 *  recipe is built around. */
export function shortOfTrigger<S>(grid: Grid<S>, symbol: S, minCount: number): number {
  return Math.max(0, minCount - countAnywhere(grid, symbol));
}
