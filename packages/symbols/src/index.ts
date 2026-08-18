// @open-rgs/symbols - the mechanics that change what a symbol on the board
// MEANS, after the board has been drawn.
//
// A generator decides what lands. These decide what it turns into: the mystery
// tile that flips to one shared symbol, the low symbols that upgrade during a
// feature, the wild that walks a reel per respin, the wild that carries a
// multiplier, and the tall symbol that counts more than once.
//
// They are here rather than in the generators because they all run in the same
// place - after the draw, before the evaluator - and because each has one
// ordering rule that decides whether the game is priced correctly. Those rules
// are the comments below.

import {
  type Grid, type Pos, heightOf, indexOf, positionsWhere, widthOf, withAt,
} from "@open-rgs/grid";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

// --- mystery tiles -----------------------------------------------------------

/**
 * Turn every mystery tile into one symbol drawn from a set.
 *
 * The convention is that they all reveal the SAME symbol, which is a variance
 * decision rather than a cosmetic one: shared reveals pay the same on average
 * as independent ones and swing far harder, because the tiles are then
 * perfectly correlated. `shared: false` draws per tile.
 *
 * Reveal BEFORE evaluating. A mystery tile is not a paying symbol, so an
 * evaluator that sees one reads a board the player never had.
 */
export function revealMystery<S>(
  grid: Grid<S>,
  mysterySymbol: S,
  from: Sampler<S> | WeightSpec<S>,
  next: () => number,
  opts: { readonly shared?: boolean } = {},
): { grid: Grid<S>; revealed: S | undefined; cells: number[] } {
  const set: Sampler<S> = typeof (from as Sampler<S>).pick === "function"
    ? (from as Sampler<S>)
    : sampler(from as WeightSpec<S>);
  const hidden = positionsWhere(grid, (s) => s === mysterySymbol);
  if (hidden.length === 0) return { grid, revealed: undefined, cells: [] };

  const cells = hidden.map((p) => indexOf(grid.shape, p.col, p.row));
  if (opts.shared === false) {
    return { grid: withAt(grid, hidden.map((p) => [p, set.pick(next())] as const)), revealed: undefined, cells };
  }
  const revealed = set.pick(next());
  return { grid: withAt(grid, hidden.map((p) => [p, revealed] as const)), revealed, cells };
}

// --- transforms --------------------------------------------------------------

/**
 * Replace every occurrence of one symbol with another.
 *
 * The feature that turns all low symbols premium, or a symbol that upgrades a
 * tier. Returns the cells it touched, because a client needs to animate them
 * and a report needs to explain the win.
 */
export function transform<S>(grid: Grid<S>, from: S, to: S): { grid: Grid<S>; cells: number[] } {
  const hits = positionsWhere(grid, (s) => s === from);
  if (hits.length === 0) return { grid, cells: [] };
  return {
    grid: withAt(grid, hits.map((p) => [p, to] as const)),
    cells: hits.map((p) => indexOf(grid.shape, p.col, p.row)),
  };
}

/** Apply several transforms in order. Order matters and is not a detail: LOW
 *  to HIGH followed by HIGH to WILD turns the lows into wilds, which is
 *  usually not what the paytable was priced for. */
export function transformAll<S>(grid: Grid<S>, pairs: ReadonlyArray<readonly [S, S]>): Grid<S> {
  let out = grid;
  for (const [from, to] of pairs) out = transform(out, from, to).grid;
  return out;
}

/** Upgrade along a declared ladder: each symbol becomes the next one. The last
 *  entry has nowhere to go and stays put, rather than wrapping to the front. */
export function upgradeLadder<S>(grid: Grid<S>, ladder: readonly S[]): Grid<S> {
  const pairs: Array<readonly [S, S]> = [];
  for (let i = ladder.length - 2; i >= 0; i--) pairs.push([ladder[i]!, ladder[i + 1]!] as const);
  // Walked from the top down, so a symbol upgraded this call is not upgraded
  // again by the next pair in the same call.
  return transformAll(grid, pairs);
}

// --- walking wilds -----------------------------------------------------------

/** A wild that moves across the board between spins. */
export interface Walker<S> {
  readonly pos: Pos;
  readonly symbol: S;
  /** Columns per step. Negative walks right to left, which is the usual
   *  direction because a left-to-right evaluator makes the last reel the
   *  cheapest place to start. */
  readonly step: number;
}

/** Place walkers on a freshly drawn board. Like a sticky cell, this is applied
 *  every spin: a walker that is only written on the spin it landed does not
 *  walk. */
export function applyWalkers<S>(grid: Grid<S>, walkers: readonly Walker<S>[]): Grid<S> {
  const inside = walkers
    .filter((w) => indexOf(grid.shape, w.pos.col, w.pos.row) >= 0)
    .map((w) => [w.pos, w.symbol] as const);
  return inside.length === 0 ? grid : withAt(grid, inside);
}

/**
 * Move every walker one step and drop the ones that walked off the board.
 *
 * Returns the survivors, so "the feature ends when the last wild leaves" is
 * `walkers.length === 0` rather than a counter that has to be kept in step
 * with the board.
 */
export function stepWalkers<S>(grid: Grid<S>, walkers: readonly Walker<S>[]): Walker<S>[] {
  const out: Walker<S>[] = [];
  for (const w of walkers) {
    const col = w.pos.col + w.step;
    if (col < 0 || col >= widthOf(grid.shape)) continue;          // walked off
    const row = Math.min(w.pos.row, heightOf(grid.shape, col) - 1); // ragged reels
    if (row < 0) continue;
    out.push({ ...w, pos: { col, row } });
  }
  return out;
}

// --- wilds that carry a multiplier -------------------------------------------

/** Factors carried by cells, keyed by position. A wild that multiplies the win
 *  it completes is the most common form; the same map covers a multiplier
 *  printed on a cell. */
export type CellFactors = ReadonlyMap<string, number>;

const key = (p: Pos): string => `${p.col}:${p.row}`;

/** No factors. */
export function noFactors(): CellFactors {
  return new Map();
}

/** Put a factor on a cell. A second factor on the same cell multiplies with
 *  the first, which is how two multiplier wilds in one win combine in almost
 *  every game that has them. */
export function withFactor(m: CellFactors, pos: Pos, factor: number): CellFactors {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new Error(`withFactor: factor must be a non-negative number, got ${factor}`);
  }
  const out = new Map(m);
  const k = key(pos);
  out.set(k, (out.get(k) ?? 1) * factor);
  return out;
}

/** The factor on a cell, or 1. */
export function factorAt(m: CellFactors, pos: Pos): number {
  return m.get(key(pos)) ?? 1;
}

/**
 * Combined factor for the cells a win covers.
 *
 * Factors on the SAME win multiply: two 2x wilds in one line pay 4x, not 3x.
 * That is the convention, and getting it wrong is a difference the top of the
 * distribution notices. Cells with no factor contribute 1, so a win that
 * touches no multiplier is unchanged.
 */
export function winFactor<S>(grid: Grid<S>, m: CellFactors, cells: readonly number[]): number {
  if (m.size === 0) return 1;
  let factor = 1;
  for (const flat of cells) {
    const pos = posOfFlat(grid, flat);
    if (pos) factor *= factorAt(m, pos);
  }
  return factor;
}

function posOfFlat<S>(grid: Grid<S>, flat: number): Pos | undefined {
  let n = flat;
  for (let col = 0; col < widthOf(grid.shape); col++) {
    const h = heightOf(grid.shape, col);
    if (n < h) return { col, row: n };
    n -= h;
  }
  return undefined;
}

// --- symbols that count more than once ---------------------------------------

/** How many symbols a cell is worth. One by default; a split symbol is two or
 *  more, and a giant symbol covering four cells is handled by big-symbols
 *  instead, because that one occupies the cells it counts. */
export type SplitCounts<S> = ReadonlyMap<S, number>;

/** Build the map: `splits([["A", 2], ["B", 3]])`. */
export function splits<S>(pairs: ReadonlyArray<readonly [S, number]>): SplitCounts<S> {
  const out = new Map<S, number>();
  for (const [symbol, count] of pairs) {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`splits: a symbol must count at least once, got ${count}`);
    }
    out.set(symbol, count);
  }
  return out;
}

/**
 * How many symbols a column holds, counting splits.
 *
 * The number a ways evaluator multiplies by: one split A in a column of three
 * is two matches, not one, so the ways for that column double. Feed this into
 * your own ways product when a game has split symbols, since `pay-ways`
 * counts cells and cannot know that a cell means two.
 */
export function countInColumn<S>(
  grid: Grid<S>,
  col: number,
  matches: (symbol: S) => boolean,
  counts: SplitCounts<S>,
): number {
  let n = 0;
  for (let row = 0; row < heightOf(grid.shape, col); row++) {
    const s = grid.cells[indexOf(grid.shape, col, row)]!;
    if (matches(s)) n += counts.get(s) ?? 1;
  }
  return n;
}

/** Ways across the columns a symbol occupies contiguously from column 0,
 *  counting splits. Zero when the run does not reach column 0. */
export function waysWithSplits<S>(
  grid: Grid<S>,
  matches: (symbol: S) => boolean,
  counts: SplitCounts<S>,
): { ways: number; columns: number } {
  let ways = 1;
  let columns = 0;
  for (let col = 0; col < widthOf(grid.shape); col++) {
    const n = countInColumn(grid, col, matches, counts);
    if (n === 0) break;
    ways *= n;
    columns++;
  }
  return columns === 0 ? { ways: 0, columns: 0 } : { ways, columns };
}
