// @open-rgs/pay-lines - the evaluator that turns a board into a win.
//
// A payline is a row index per column: [1,1,1,1,1] is the middle row of a 5x3.
// Evaluation walks it left to right, finds the longest run of one symbol
// (wilds substituting), and looks up the paytable.
//
// THREE RULES THAT ARE EASY TO GET WRONG, and each costs real money:
//
//   1. A line pays ONCE, for its longest qualifying run. Paying every prefix
//      (3-of-a-kind AND 4-of-a-kind AND 5) roughly doubles the game's RTP.
//
//   2. A run of only wilds is ambiguous - it can be read as the wild's own
//      symbol, or as whichever symbol it substitutes for further along. The
//      convention is to pay whichever is worth more. Reading it only as the
//      wild silently underpays the most exciting board in the game.
//
//   3. A wild never substitutes for a scatter, so a scatter run cannot be
//      manufactured. Feature frequency is usually the single largest term in
//      RTP, and a wild that triggers features quietly rewrites it.
//
// Ragged grids are handled by construction: a line that names a row the column
// does not have simply ends there, which is what "the reel is shorter" means.

import { type Grid, type Pos, indexOf, widthOf } from "@open-rgs/grid";
import { type Paytable, type Roles, type Win, isScatter, isWild, substitutes } from "@open-rgs/paytable";

/** One payline: the row it visits in each column, left to right. A column whose
 *  entry is out of range (or absent) terminates the line there. */
export type Line = readonly number[];

/** Straight rows for a rectangular grid - the usual starting point. */
export function rowLines(width: number, height: number): Line[] {
  return Array.from({ length: height }, (_, row) => Array.from({ length: width }, () => row));
}

export interface EvalOptions<S = string> {
  readonly roles?: Roles<S>;
  /** Also evaluate right-to-left and keep the better of the two.
   *  A "both ways" game pays a run anchored at EITHER end, so the two readings
   *  compete rather than accumulate - paying both would double-count a run that
   *  spans the whole grid. */
  readonly bothWays?: boolean;
}

/** Positions a line visits, stopping where the grid runs out. */
function lineCells<S>(grid: Grid<S>, line: Line): Pos[] {
  const out: Pos[] = [];
  for (let col = 0; col < Math.min(line.length, widthOf(grid.shape)); col++) {
    const row = line[col]!;
    if (indexOf(grid.shape, col, row) < 0) break; // short reel: the line ends
    out.push({ col, row });
  }
  return out;
}

function symbolAt<S>(grid: Grid<S>, p: Pos): S {
  return grid.cells[indexOf(grid.shape, p.col, p.row)]!;
}

/** Longest run of `target` from the start of `cells`, wilds substituting. */
function runLength<S>(grid: Grid<S>, cells: readonly Pos[], target: S, roles: Roles<S>): number {
  let n = 0;
  for (const p of cells) {
    if (!substitutes(symbolAt(grid, p), target, roles)) break;
    n++;
  }
  return n;
}

/** Evaluate one direction of one line. */
function evalDirection<S>(
  grid: Grid<S>,
  cells: readonly Pos[],
  pay: Paytable<S>,
  roles: Roles<S>,
  lineIndex: number,
): Win<S> | undefined {
  if (cells.length === 0) return undefined;

  const first = symbolAt(grid, cells[0]!);
  // A scatter never pays on a line - it pays on total count, wherever it lands.
  if (isScatter(first, roles)) return undefined;

  // Candidate symbols this run could be read as. Normally just the first
  // symbol; when the run opens with wilds, also the first non-wild it reaches,
  // because that is the substitution the player expects to be paid.
  const candidates: S[] = [first];
  if (isWild(first, roles)) {
    for (const p of cells) {
      const s = symbolAt(grid, p);
      if (!isWild(s, roles)) {
        if (!isScatter(s, roles)) candidates.push(s);
        break;
      }
    }
  }

  let best: Win<S> | undefined;
  for (const target of candidates) {
    const count = runLength(grid, cells, target, roles);
    if (count === 0) continue;
    const multiplier = pay.pay(target, count);
    if (multiplier <= 0) continue;
    if (!best || multiplier > best.multiplier) {
      best = {
        symbol: target,
        count,
        multiplier,
        positions: cells.slice(0, count).map((p) => indexOf(grid.shape, p.col, p.row)),
        line: lineIndex,
      };
    }
  }
  return best;
}

/**
 * Evaluate one payline. Returns the single best win on it, or undefined.
 *
 * "Best" resolves both ambiguities at once: a wild-opening run reads as
 * whichever symbol pays more, and under `bothWays` the two directions compete
 * rather than accumulate.
 */
export function evalLine<S>(
  grid: Grid<S>,
  line: Line,
  pay: Paytable<S>,
  opts: EvalOptions<S> = {},
  lineIndex = 0,
): Win<S> | undefined {
  const roles = opts.roles ?? {};
  const cells = lineCells(grid, line);

  const left = evalDirection(grid, cells, pay, roles, lineIndex);
  if (!opts.bothWays) return left;

  const right = evalDirection(grid, [...cells].reverse(), pay, roles, lineIndex);
  if (!left) return right;
  if (!right) return left;
  return right.multiplier > left.multiplier ? right : left;
}

/** Evaluate every payline. One win per line at most. */
export function evalLines<S>(
  grid: Grid<S>,
  lines: readonly Line[],
  pay: Paytable<S>,
  opts: EvalOptions<S> = {},
): Win<S>[] {
  const wins: Win<S>[] = [];
  for (let i = 0; i < lines.length; i++) {
    const w = evalLine(grid, lines[i]!, pay, opts, i);
    if (w) wins.push(w);
  }
  return wins;
}
