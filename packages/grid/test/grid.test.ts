// The ragged cases carry this suite. A rectangular grid is easy and every
// implementation gets it right; the bugs live where columns differ in height,
// which is exactly the case this package exists to make ordinary.

import { describe, expect, test } from "bun:test";
import {
  appendColumn, appendColumns, assertShape, at, column, countOf, countWhere, fromColumns, heightOf, indexOf, isRectangular, makeGrid, mapGrid, neighbours, posOf, positions, positionsOf, positionsWhere, rect, samePos, sizeOf, toColumns, widthOf, withAt,
} from "../src/index.js";

// 4-5-5-5-5-4, the divan-2 shape. Deliberately ragged at both ends.
const RAGGED = [4, 5, 5, 5, 5, 4] as const;
const R53 = rect(5, 3);

describe("shape", () => {
  test("rect builds equal columns", () => {
    expect(R53).toEqual([3, 3, 3, 3, 3]);
    expect(sizeOf(R53)).toBe(15);
    expect(isRectangular(R53)).toBe(true);
  });

  test("ragged shapes are first-class, not a special case", () => {
    expect(sizeOf(RAGGED)).toBe(28);
    expect(widthOf(RAGGED)).toBe(6);
    expect(isRectangular(RAGGED)).toBe(false);
    expect(heightOf(RAGGED, 0)).toBe(4);
    expect(heightOf(RAGGED, 2)).toBe(5);
  });

  test("heightOf is 0 off the grid rather than throwing", () => {
    expect(heightOf(RAGGED, -1)).toBe(0);
    expect(heightOf(RAGGED, 99)).toBe(0);
  });

  test("assertShape rejects what a grid cannot represent", () => {
    expect(() => assertShape([])).toThrow(/at least one column/);
    expect(() => assertShape([3, 0, 3])).toThrow(/column 1/);
    expect(() => assertShape([3, -1])).toThrow(/positive integer/);
    expect(() => assertShape([3, 2.5])).toThrow(/positive integer/);
    expect(() => assertShape(RAGGED)).not.toThrow();
  });

  test("rect rejects a degenerate size", () => {
    expect(() => rect(0, 3)).toThrow(/width/);
    expect(() => rect(5, 0)).toThrow(/height/);
  });
});

describe("indexing", () => {
  test("flat offsets account for preceding column heights", () => {
    // column 0 is 4 tall, so column 1 starts at 4; column 1 is 5 tall, so
    // column 2 starts at 9.
    expect(indexOf(RAGGED, 0, 0)).toBe(0);
    expect(indexOf(RAGGED, 1, 0)).toBe(4);
    expect(indexOf(RAGGED, 2, 0)).toBe(9);
    expect(indexOf(RAGGED, 5, 3)).toBe(27);
  });

  test("a row past a SHORT column is off-grid, not wrapped into the next", () => {
    // The whole hazard of ragged shapes: row 4 exists in column 1 but not in
    // column 0. Naive width*height arithmetic silently returns a neighbour.
    expect(indexOf(RAGGED, 1, 4)).toBe(8);
    expect(indexOf(RAGGED, 0, 4)).toBe(-1);
    expect(indexOf(RAGGED, 5, 4)).toBe(-1);
  });

  test("out-of-range coordinates report rather than throw", () => {
    expect(indexOf(RAGGED, -1, 0)).toBe(-1);
    expect(indexOf(RAGGED, 6, 0)).toBe(-1);
    expect(indexOf(RAGGED, 0, -1)).toBe(-1);
  });

  test("posOf inverts indexOf across the whole grid", () => {
    for (let i = 0; i < sizeOf(RAGGED); i++) {
      const p = posOf(RAGGED, i);
      expect(p).toBeDefined();
      expect(indexOf(RAGGED, p!.col, p!.row)).toBe(i);
    }
    expect(posOf(RAGGED, sizeOf(RAGGED))).toBeUndefined();
    expect(posOf(RAGGED, -1)).toBeUndefined();
  });
});

describe("construction and views", () => {
  test("makeGrid fills by position", () => {
    const g = makeGrid(RAGGED, ({ col, row }) => `${col}:${row}`);
    expect(g.cells).toHaveLength(28);
    expect(at(g, 0, 0)).toBe("0:0");
    expect(at(g, 2, 4)).toBe("2:4");
    expect(at(g, 5, 3)).toBe("5:3");
  });

  test("at returns undefined off the grid, including a short column", () => {
    const g = makeGrid(RAGGED, ({ col, row }) => `${col}:${row}`);
    expect(at(g, 0, 4)).toBeUndefined();
    expect(at(g, 6, 0)).toBeUndefined();
  });

  test("fromColumns infers a ragged shape from column lengths", () => {
    const g = fromColumns([["a", "b"], ["c", "d", "e"], ["f"]]);
    expect(g.shape).toEqual([2, 3, 1]);
    expect(at(g, 1, 2)).toBe("e");
    expect(at(g, 2, 1)).toBeUndefined();
  });

  test("toColumns round-trips fromColumns", () => {
    const cols = [["a", "b"], ["c", "d", "e"], ["f"]];
    expect(toColumns(fromColumns(cols))).toEqual(cols);
  });

  test("column reads one reel top to bottom", () => {
    const g = makeGrid(RAGGED, ({ col, row }) => `${col}:${row}`);
    expect(column(g, 0)).toEqual(["0:0", "0:1", "0:2", "0:3"]);
    expect(column(g, 1)).toHaveLength(5);
    expect(column(g, 99)).toEqual([]);
  });
});

describe("queries", () => {
  const g = fromColumns([
    ["A", "B", "A"],
    ["A", "C"],
    ["B", "B", "A", "A"],
  ]);

  test("positions enumerates column-major", () => {
    expect(positions([2, 1])).toEqual([
      { col: 0, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 0 },
    ]);
  });

  test("countOf and positionsOf agree", () => {
    expect(countOf(g, "A")).toBe(5);
    expect(positionsOf(g, "A")).toHaveLength(5);
    expect(countOf(g, "Z")).toBe(0);
  });

  test("positionsWhere reports the right coordinates on a ragged grid", () => {
    const found = positionsWhere(g, (s, p) => s === "A" && p.col === 2);
    expect(found).toEqual([{ col: 2, row: 2 }, { col: 2, row: 3 }]);
  });

  test("countWhere sees position as well as symbol", () => {
    expect(countWhere(g, (_s, p) => p.row === 0)).toBe(3); // one per column
    expect(countWhere(g, (s, p) => s === "B" && p.col === 0)).toBe(1);
  });
});

describe("transforms", () => {
  test("mapGrid preserves shape", () => {
    const g = makeGrid(RAGGED, () => 1);
    const m = mapGrid(g, (n, p) => n + p.col);
    expect(m.shape).toBe(g.shape);
    expect(at(m, 3, 0)).toBe(4);
  });

  test("withAt copies rather than mutating", () => {
    const g = fromColumns([["a", "b"], ["c"]]);
    const h = withAt(g, [[{ col: 0, row: 1 }, "Z"]]);
    expect(at(h, 0, 1)).toBe("Z");
    expect(at(g, 0, 1)).toBe("b"); // original untouched
  });

  test("withAt ignores off-grid writes so callers need not pre-filter", () => {
    const g = fromColumns([["a", "b"], ["c"]]);
    const h = withAt(g, [[{ col: 1, row: 5 }, "Z"], [{ col: 0, row: 0 }, "Y"]]);
    expect(h.cells).toEqual(["Y", "b", "c"]);
  });
});

describe("neighbours", () => {
  test("interior cell has four", () => {
    expect(neighbours(rect(3, 3), { col: 1, row: 1 })).toHaveLength(4);
  });

  test("corner has two", () => {
    expect(neighbours(rect(3, 3), { col: 0, row: 0 })).toHaveLength(2);
  });

  test("a ragged edge can give a left neighbour but no right one", () => {
    // Column 1 is 5 tall, columns 0 and 2 are 4 and 4. At (1,4) there is a cell
    // below-left of nothing: no (0,4), no (2,4). Only (1,3) survives.
    const shape = [4, 5, 4] as const;
    const n = neighbours(shape, { col: 1, row: 4 });
    expect(n).toEqual([{ col: 1, row: 3 }]);
  });

  test("samePos compares coordinates", () => {
    expect(samePos({ col: 1, row: 2 }, { col: 1, row: 2 })).toBe(true);
    expect(samePos({ col: 1, row: 2 }, { col: 2, row: 1 })).toBe(false);
  });
});

describe("a board that grows mid-round", () => {
  test("a new column arrives on the right, filled by the callback", () => {
    const g = makeGrid(rect(2, 3), () => "LOW");
    const out = appendColumn(g, 3, (p) => `new-${p.col}-${p.row}`);
    expect(out.shape).toEqual([3, 3, 3]);
    expect(toColumns(out)[2]).toEqual(["new-2-0", "new-2-1", "new-2-2"]);
  });

  test("existing columns keep their index and their cells, so anything written against the old board still points where it did", () => {
    const g = fromColumns([["a", "b"], ["c", "d"]]);
    const out = appendColumn(g, 2, () => "x");
    expect(at(out, 0, 0)).toBe("a");
    expect(at(out, 1, 1)).toBe("d");
    expect(indexOf(out.shape, 1, 1)).toBe(indexOf(g.shape, 1, 1));
  });

  test("a taller or shorter new column is fine, because shape is per column", () => {
    const g = makeGrid(rect(1, 2), () => "LOW");
    expect(appendColumn(g, 5, () => "x").shape).toEqual([2, 5]);
  });

  test("several at once", () => {
    const g = makeGrid(rect(1, 2), () => "LOW");
    const out = appendColumns(g, 3, 2, () => "x");
    expect(out.shape).toEqual([2, 2, 2, 2]);
    expect(sizeOf(out.shape)).toBe(out.cells.length);
  });

  test("a column with no height is refused rather than producing a hole in the shape", () => {
    const g = makeGrid(rect(1, 2), () => "LOW");
    expect(() => appendColumn(g, 0, () => "x")).toThrow(/positive integer/);
    expect(() => appendColumns(g, -1, 2, () => "x")).toThrow(/non-negative integer/);
  });
});
