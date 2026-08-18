// @open-rgs/grid - the substrate every reel mechanic and pay evaluator reads.
//
// ONE DESIGN DECISION drives this whole package: a grid's shape is
// `readonly number[]` - a height PER COLUMN - not a `width x height` pair.
// Rectangular grids are the case where every entry happens to be equal.
//
// That is deliberate and it is load-bearing. Ragged reel sets are ordinary in
// production slots (4-5-5-5-5-4, 3-4-4-4-4-3), and a pay evaluator written
// against `width x height` has the rectangle baked into every traversal. Adding
// ragged support later is not a feature, it is a rewrite of every evaluator
// that reads a grid. Supporting it on day one costs one extra array.
//
// Cells are stored FLAT in column-major order, so a spin allocates one array
// rather than one per column. `toColumns` exists for when nesting reads better.

/** Height of each column, left to right. `[3,3,3,3,3]` is a 5x3; `[4,5,5,5,5,4]`
 *  is a ragged six-reel set. Every entry must be a positive integer. */
export type Shape = readonly number[];

/** A filled grid. `cells` is column-major and flat: column 0 occupies the first
 *  `shape[0]` entries, column 1 the next `shape[1]`, and so on. Read it through
 *  {@link at} rather than indexing directly - the offsets are shape-dependent. */
export interface Grid<S = string> {
  readonly shape: Shape;
  readonly cells: readonly S[];
}

/** A cell coordinate. `row` counts from the TOP of its column (row 0 is the
 *  topmost visible cell), which matches how reel windows and paylines are
 *  described. */
export interface Pos {
  readonly col: number;
  readonly row: number;
}

/** Total cells in a shape. */
export function sizeOf(shape: Shape): number {
  let n = 0;
  for (const h of shape) n += h;
  return n;
}

/** Flat offset where a column's cells begin. */
function columnStart(shape: Shape, col: number): number {
  let n = 0;
  for (let c = 0; c < col; c++) n += shape[c]!;
  return n;
}

/** Flat index of (col, row), or -1 if the coordinate is off the grid.
 *  Ragged shapes make out-of-range rows normal rather than exceptional - a
 *  payline crossing a short column simply has no cell there - so this reports
 *  rather than throws. */
export function indexOf(shape: Shape, col: number, row: number): number {
  if (col < 0 || col >= shape.length) return -1;
  const h = shape[col]!;
  if (row < 0 || row >= h) return -1;
  return columnStart(shape, col) + row;
}

/** Inverse of {@link indexOf}. Returns undefined for an out-of-range index. */
export function posOf(shape: Shape, index: number): Pos | undefined {
  if (index < 0) return undefined;
  let n = index;
  for (let col = 0; col < shape.length; col++) {
    const h = shape[col]!;
    if (n < h) return { col, row: n };
    n -= h;
  }
  return undefined;
}

/** Symbol at (col, row), or undefined if the coordinate is off the grid. */
export function at<S>(grid: Grid<S>, col: number, row: number): S | undefined {
  const i = indexOf(grid.shape, col, row);
  return i < 0 ? undefined : grid.cells[i];
}

/** Number of columns. */
export function widthOf(shape: Shape): number {
  return shape.length;
}

/** Height of one column, or 0 if the column does not exist. */
export function heightOf(shape: Shape, col: number): number {
  return col >= 0 && col < shape.length ? shape[col]! : 0;
}

/** True when every column is the same height - i.e. the grid is a rectangle.
 *  Evaluators can use this to take a faster path, never to assume one. */
export function isRectangular(shape: Shape): boolean {
  if (shape.length === 0) return true;
  const h = shape[0]!;
  return shape.every((x) => x === h);
}

/** Validate a shape. Throws on anything a grid cannot represent - caught at
 *  game boot rather than mid-spin. */
export function assertShape(shape: Shape): void {
  if (shape.length === 0) throw new Error("grid shape must have at least one column");
  for (let c = 0; c < shape.length; c++) {
    const h = shape[c]!;
    if (!Number.isInteger(h) || h <= 0) {
      throw new Error(`grid shape column ${c} must be a positive integer, got ${h}`);
    }
  }
}

/** A rectangular shape - the common case, spelled explicitly. */
export function rect(width: number, height: number): Shape {
  if (!Number.isInteger(width) || width <= 0) throw new Error(`rect width must be a positive integer, got ${width}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error(`rect height must be a positive integer, got ${height}`);
  return Array.from({ length: width }, () => height);
}

/** Build a grid from a per-position producer. */
export function makeGrid<S>(shape: Shape, fill: (pos: Pos) => S): Grid<S> {
  assertShape(shape);
  const cells: S[] = new Array(sizeOf(shape)) as S[];
  let i = 0;
  for (let col = 0; col < shape.length; col++) {
    const h = shape[col]!;
    for (let row = 0; row < h; row++) cells[i++] = fill({ col, row });
  }
  return { shape, cells };
}

/** Build a grid from nested columns. The shape is inferred from the column
 *  lengths, so a ragged array of arrays is the natural input. */
export function fromColumns<S>(columns: ReadonlyArray<readonly S[]>): Grid<S> {
  const shape = columns.map((c) => c.length);
  assertShape(shape);
  const cells: S[] = new Array(sizeOf(shape)) as S[];
  let i = 0;
  for (const column of columns) for (const s of column) cells[i++] = s;
  return { shape, cells };
}

/**
 * Add a column on the right, filled by `fill`.
 *
 * The board grows during a round in more games than it used to: a reel added
 * on every win, a row unlocked at a coin count. Growing a `Grid` is honest
 * because shape is a height per column, so a wider board is a longer array
 * rather than a different kind of object, and every evaluator already reads
 * the shape it is given.
 *
 * What it does NOT do is renumber anything: existing columns keep their index
 * and their cells, so a payline, a sticky cell or a cell multiplier written
 * against the old board still points where it did.
 */
export function appendColumn<S>(grid: Grid<S>, height: number, fill: (pos: Pos) => S): Grid<S> {
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error(`appendColumn: height must be a positive integer, got ${height}`);
  }
  const col = grid.shape.length;
  const added: S[] = [];
  for (let row = 0; row < height; row++) added.push(fill({ col, row }));
  return { shape: [...grid.shape, height], cells: [...grid.cells, ...added] };
}

/** Add `count` columns at once, each the same height. */
export function appendColumns<S>(grid: Grid<S>, count: number, height: number, fill: (pos: Pos) => S): Grid<S> {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`appendColumns: count must be a non-negative integer, got ${count}`);
  }
  let out = grid;
  for (let i = 0; i < count; i++) out = appendColumn(out, height, fill);
  return out;
}

/** Nested view of a grid, one array per column. Allocates - prefer {@link at}
 *  on a hot path. */
export function toColumns<S>(grid: Grid<S>): S[][] {
  const out: S[][] = [];
  let i = 0;
  for (const h of grid.shape) {
    out.push(grid.cells.slice(i, i + h) as S[]);
    i += h;
  }
  return out;
}

/** Every position, column-major. */
export function positions(shape: Shape): Pos[] {
  const out: Pos[] = [];
  for (let col = 0; col < shape.length; col++) {
    const h = shape[col]!;
    for (let row = 0; row < h; row++) out.push({ col, row });
  }
  return out;
}

/** Positions whose symbol satisfies `match`. The workhorse behind scatter
 *  counts, collector location, cluster seeding and cascade removal. */
export function positionsWhere<S>(grid: Grid<S>, match: (s: S, pos: Pos) => boolean): Pos[] {
  const out: Pos[] = [];
  let i = 0;
  for (let col = 0; col < grid.shape.length; col++) {
    const h = grid.shape[col]!;
    for (let row = 0; row < h; row++, i++) {
      if (match(grid.cells[i]!, { col, row })) out.push({ col, row });
    }
  }
  return out;
}

/** Positions holding exactly `symbol`. */
export function positionsOf<S>(grid: Grid<S>, symbol: S): Pos[] {
  return positionsWhere(grid, (s) => s === symbol);
}

/** How many cells hold `symbol`. */
export function countOf<S>(grid: Grid<S>, symbol: S): number {
  let n = 0;
  for (const s of grid.cells) if (s === symbol) n++;
  return n;
}

/** How many cells satisfy `match`. */
export function countWhere<S>(grid: Grid<S>, match: (s: S, pos: Pos) => boolean): number {
  let n = 0;
  let i = 0;
  for (let col = 0; col < grid.shape.length; col++) {
    const h = grid.shape[col]!;
    for (let row = 0; row < h; row++, i++) {
      if (match(grid.cells[i]!, { col, row })) n++;
    }
  }
  return n;
}

/** Symbols in one column, top to bottom. */
export function column<S>(grid: Grid<S>, col: number): S[] {
  const h = heightOf(grid.shape, col);
  if (h === 0) return [];
  const start = columnStart(grid.shape, col);
  return grid.cells.slice(start, start + h) as S[];
}

/** Map every cell, preserving shape. */
export function mapGrid<S, T>(grid: Grid<S>, fn: (s: S, pos: Pos) => T): Grid<T> {
  const cells: T[] = new Array(grid.cells.length) as T[];
  let i = 0;
  for (let col = 0; col < grid.shape.length; col++) {
    const h = grid.shape[col]!;
    for (let row = 0; row < h; row++, i++) cells[i] = fn(grid.cells[i]!, { col, row });
  }
  return { shape: grid.shape, cells };
}

/** A copy with the given positions replaced. Positions off the grid are
 *  ignored, so a caller need not pre-filter a payline against a ragged shape. */
export function withAt<S>(grid: Grid<S>, writes: ReadonlyArray<readonly [Pos, S]>): Grid<S> {
  const cells = grid.cells.slice() as S[];
  for (const [pos, value] of writes) {
    const i = indexOf(grid.shape, pos.col, pos.row);
    if (i >= 0) cells[i] = value;
  }
  return { shape: grid.shape, cells };
}

/** Two positions are the same cell. */
export function samePos(a: Pos, b: Pos): boolean {
  return a.col === b.col && a.row === b.row;
}

/** Orthogonal neighbours that exist on this shape. Ragged columns make this
 *  non-obvious - a cell can have a left neighbour but no right one - so
 *  cluster evaluation should ask rather than compute. */
export function neighbours(shape: Shape, pos: Pos): Pos[] {
  const out: Pos[] = [];
  const candidates: Pos[] = [
    { col: pos.col - 1, row: pos.row },
    { col: pos.col + 1, row: pos.row },
    { col: pos.col, row: pos.row - 1 },
    { col: pos.col, row: pos.row + 1 },
  ];
  for (const c of candidates) if (indexOf(shape, c.col, c.row) >= 0) out.push(c);
  return out;
}
