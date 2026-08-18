// @open-rgs/big-symbols - one symbol occupying a w-by-h block of cells.
//
// The representation is the design. A big symbol is written as the SAME symbol
// repeated across every cell it covers. There is no overlay structure, no
// "this block is really one thing" marker, no parallel geometry for evaluators
// to learn about.
//
// That choice is what makes big symbols work with the rest of the stack for
// free, and it matches what players are paid: a 2x2 WILD really does act as
// four wilds. A ways evaluator sees 2 matches in each of 2 columns and
// multiplies correctly. A payline crossing the block matches on both rows. A
// cluster fill absorbs all four cells. None of those packages know this one
// exists.
//
// The client still needs to DRAW one big tile rather than four small ones, so
// `blocksOf` recovers the block layout from a finished grid. Presentation reads
// it back; the maths never needs it.
//
// Fit is not obvious on a ragged grid. A 2x2 needs two adjacent columns that
// are BOTH tall enough at those rows. On a multiways board where reel 3 drew a
// height of 2, a block that fits everywhere else does not fit there - so
// placement asks rather than assumes.

import { type Grid, type Pos, type Shape, heightOf, indexOf, widthOf, withAt } from "@open-rgs/grid";
import { type Sampler } from "@open-rgs/weights";

/** A placed block: its top-left cell and its size. */
export interface Block {
  readonly pos: Pos;
  readonly width: number;
  readonly height: number;
}

/** Does a `width` x `height` block fit with its top-left corner at `pos`? */
export function fits(shape: Shape, pos: Pos, width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  if (pos.col < 0 || pos.row < 0) return false;
  if (pos.col + width > widthOf(shape)) return false;
  for (let c = pos.col; c < pos.col + width; c++) {
    // Every covered column must reach the block's bottom row. On a ragged
    // board this is the check that actually bites.
    if (heightOf(shape, c) < pos.row + height) return false;
  }
  return true;
}

/** Every top-left position where a `width` x `height` block fits, column-major. */
export function placements(shape: Shape, width: number, height: number): Pos[] {
  const out: Pos[] = [];
  for (let col = 0; col < widthOf(shape); col++) {
    for (let row = 0; row < heightOf(shape, col); row++) {
      if (fits(shape, { col, row }, width, height)) out.push({ col, row });
    }
  }
  return out;
}

// --- the expanding symbol ---------------------------------------------------
//
// A block is a symbol that ARRIVES big. An expanding symbol arrives normal and
// then grows to fill its reel: the book game's special symbol, the expanding
// wild. Different mechanic, different price, so it is a different function.
// The geometry is simpler (a whole column, never a rectangle) and the question
// is which columns qualify rather than where a rectangle fits.

/** Columns holding at least one `symbol`: the candidates to expand. */
export function columnsHolding<S>(grid: Grid<S>, symbol: S): number[] {
  const out: number[] = [];
  for (let col = 0; col < widthOf(grid.shape); col++) {
    for (let row = 0; row < heightOf(grid.shape, col); row++) {
      if (grid.cells[indexOf(grid.shape, col, row)] === symbol) { out.push(col); break; }
    }
  }
  return out;
}

/** Fill one column with a symbol. */
export function expandColumn<S>(grid: Grid<S>, col: number, symbol: S): Grid<S> {
  const height = heightOf(grid.shape, col);
  if (height === 0) return grid;
  const writes: Array<readonly [Pos, S]> = [];
  for (let row = 0; row < height; row++) writes.push([{ col, row }, symbol] as const);
  return withAt(grid, writes);
}

/**
 * Expand every column holding `symbol` so it fills that column.
 *
 * The evaluator then sees a full column, which is what makes an expanded
 * symbol pay across the board rather than on the cell it landed on. Ragged
 * grids expand to each column's own height, so a short reel is filled short.
 */
export function expandSymbol<S>(grid: Grid<S>, symbol: S): { grid: Grid<S>; columns: number[] } {
  const columns = columnsHolding(grid, symbol);
  let out = grid;
  for (const col of columns) out = expandColumn(out, col, symbol);
  return { grid: out, columns };
}

/** Cells an expansion would write, without writing them: for a client that
 *  animates the growth before the board changes. */
export function expansionCells<S>(grid: Grid<S>, symbol: S): number[] {
  const out: number[] = [];
  for (const col of columnsHolding(grid, symbol)) {
    for (let row = 0; row < heightOf(grid.shape, col); row++) {
      out.push(indexOf(grid.shape, col, row));
    }
  }
  return out;
}

/** Flat indices a block covers. Empty when it does not fit. */
export function cellsOf(shape: Shape, block: Block): number[] {
  if (!fits(shape, block.pos, block.width, block.height)) return [];
  const out: number[] = [];
  for (let c = block.pos.col; c < block.pos.col + block.width; c++) {
    for (let r = block.pos.row; r < block.pos.row + block.height; r++) {
      out.push(indexOf(shape, c, r));
    }
  }
  return out;
}

/**
 * Write a big symbol onto the board.
 *
 * Throws when the block does not fit, rather than clipping. A clipped big
 * symbol is a 2x1 pretending to be a 2x2: it pays less than the game promised
 * and nothing downstream can tell, because by then it is just symbols.
 */
export function placeBig<S>(grid: Grid<S>, block: Block, symbol: S): Grid<S> {
  const cells = cellsOf(grid.shape, block);
  if (cells.length === 0) {
    throw new Error(
      `placeBig: a ${block.width}x${block.height} block does not fit at ` +
        `(${block.pos.col}, ${block.pos.row}) on shape [${grid.shape.join(",")}]`,
    );
  }
  const writes: Array<readonly [Pos, S]> = [];
  for (let c = block.pos.col; c < block.pos.col + block.width; c++) {
    for (let r = block.pos.row; r < block.pos.row + block.height; r++) {
      writes.push([{ col: c, row: r }, symbol]);
    }
  }
  return withAt(grid, writes);
}

/**
 * Recover the block layout of `symbol` from a finished grid, largest first.
 *
 * For presentation only - a client needs to draw one tile rather than four.
 * Greedy and therefore not a unique decomposition: a 2x4 run of the same symbol
 * can be read as one 2x4 or two 2x2s, and this returns whichever the scan meets
 * first. That is fine for drawing and wrong for anything that pays, which is
 * exactly why nothing that pays uses it.
 */
export function blocksOf<S>(grid: Grid<S>, symbol: S, sizes: ReadonlyArray<readonly [number, number]>): Block[] {
  const taken = new Set<number>();
  const out: Block[] = [];
  const bySizeDesc = [...sizes].sort((a, b) => b[0] * b[1] - a[0] * a[1]);

  for (const [width, height] of bySizeDesc) {
    for (const pos of placements(grid.shape, width, height)) {
      const cells = cellsOf(grid.shape, { pos, width, height });
      if (cells.some((i) => taken.has(i))) continue;
      if (!cells.every((i) => grid.cells[i] === symbol)) continue;
      for (const i of cells) taken.add(i);
      out.push({ pos, width, height });
    }
  }
  return out;
}

/** How many cells a big symbol contributes. Its own size - which is precisely
 *  why the repeated-cell representation makes every evaluator correct without
 *  knowing about blocks. */
export function weightOfBlock(block: Block): number {
  return block.width * block.height;
}

/**
 * Place one big symbol at a random legal position.
 *
 * Returns the grid unchanged when nothing fits, rather than throwing: on a
 * multiways board a 3x3 genuinely may not fit any spin, and a feature that
 * cannot place is a normal outcome to price, not an error to crash on.
 * Consumes one float when a placement exists, none otherwise.
 */
export function placeRandomBig<S>(
  grid: Grid<S>,
  symbol: S,
  width: number,
  height: number,
  next: () => number,
): Grid<S> {
  const spots = placements(grid.shape, width, height);
  if (spots.length === 0) return grid;
  const r = next();
  let i = Math.floor((r <= 0 ? 0 : r >= 1 ? 1 : r) * spots.length);
  if (i >= spots.length) i = spots.length - 1;
  return placeBig(grid, { pos: spots[i]!, width, height }, symbol);
}

/** Draw the size as well as the position - "a 2x2 or a 3x3, weighted". */
export function placeDrawnBig<S>(
  grid: Grid<S>,
  symbol: S,
  sizes: Sampler<readonly [number, number]>,
  next: () => number,
): Grid<S> {
  const [width, height] = sizes.pick(next());
  return placeRandomBig(grid, symbol, width, height, next);
}
