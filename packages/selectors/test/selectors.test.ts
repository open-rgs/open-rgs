// Three things this suite is really guarding:
//   1. Column-major order is STABLE - an unstable order makes a seeded replay
//      diverge between versions, which surfaces in a certification rerun.
//   2. randomN throws rather than under-delivering, because a placement
//      directive has already priced its count into the RTP model.
//   3. Ragged grids behave - a row that exists in one column and not the next
//      is the normal case, not an edge case.

import { describe, expect, test } from "bun:test";
import { fromColumns, type Pos, rect, makeGrid } from "@open-rgs/grid";
import {
  all, at, col, cols, countSelected, except, holding, holdingAny, intersect,
  none, not, oneOf, others, randomN, rows, union, upTo, where,
} from "../src/index.js";

const NO_RNG = () => {
  throw new Error("selector consumed randomness it should not need");
};
/** Deterministic float source, so draws are reproducible in assertions. */
const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };

// Ragged: column 1 is taller than its neighbours.
const G = fromColumns([
  ["A", "B"],
  ["A", "C", "A"],
  ["B", "A"],
]);

const key = (p: Pos) => `${p.col},${p.row}`;
const keys = (ps: Pos[]) => ps.map(key);

describe("basic selections", () => {
  test("all is every cell, column-major", () => {
    expect(keys(all()(G, NO_RNG))).toEqual(["0,0", "0,1", "1,0", "1,1", "1,2", "2,0", "2,1"]);
  });

  test("none is empty", () => {
    expect(none()(G, NO_RNG)).toEqual([]);
  });

  test("col and cols take whole reels", () => {
    expect(keys(col(1)(G, NO_RNG))).toEqual(["1,0", "1,1", "1,2"]);
    expect(keys(cols([0, 2])(G, NO_RNG))).toEqual(["0,0", "0,1", "2,0", "2,1"]);
  });

  test("cols ignores out-of-range columns instead of throwing", () => {
    // A directive written for a 6-reel set should degrade on a 5-reel one.
    expect(keys(cols([0, 99, -1])(G, NO_RNG))).toEqual(["0,0", "0,1"]);
  });

  test("rows skips columns that are too short", () => {
    // Row 2 exists only in column 1 on this ragged grid.
    expect(keys(rows([2])(G, NO_RNG))).toEqual(["1,2"]);
    expect(keys(rows([0])(G, NO_RNG))).toEqual(["0,0", "1,0", "2,0"]);
  });

  test("where and holding find symbols", () => {
    expect(keys(holding("A")(G, NO_RNG))).toEqual(["0,0", "1,0", "1,2", "2,1"]);
    expect(keys(holdingAny(["B", "C"])(G, NO_RNG))).toEqual(["0,1", "1,1", "2,0"]);
    expect(keys(where<string>((s, p) => s === "A" && p.col === 1)(G, NO_RNG))).toEqual(["1,0", "1,2"]);
  });

  test("at and others address one cell", () => {
    expect(keys(at({ col: 1, row: 2 })(G, NO_RNG))).toEqual(["1,2"]);
    expect(at({ col: 0, row: 9 })(G, NO_RNG)).toEqual([]); // off-grid
    expect(others({ col: 0, row: 0 })(G, NO_RNG)).toHaveLength(6);
    expect(keys(others({ col: 0, row: 0 })(G, NO_RNG))).not.toContain("0,0");
  });
});

describe("composition", () => {
  test("union de-duplicates and restores column-major order", () => {
    // Deliberately passed out of order; the result must not reflect that.
    const s = union(col(2), col(0), holding("A"));
    expect(keys(s(G, NO_RNG))).toEqual(["0,0", "0,1", "1,0", "1,2", "2,0", "2,1"]);
  });

  test("intersect narrows", () => {
    expect(keys(intersect(col(1), holding("A"))(G, NO_RNG))).toEqual(["1,0", "1,2"]);
  });

  test("except subtracts", () => {
    expect(keys(except(col(1), holding("A"))(G, NO_RNG))).toEqual(["1,1"]);
  });

  test("not complements against the whole grid", () => {
    expect(keys(not(holding("A"))(G, NO_RNG))).toEqual(["0,1", "1,1", "2,0"]);
  });

  test("composing an empty selection stays empty rather than falling back to all", () => {
    expect(intersect(holding("Z"), all())(G, NO_RNG)).toEqual([]);
    expect(union(none(), none())(G, NO_RNG)).toEqual([]);
  });
});

describe("random draws", () => {
  test("randomN returns exactly n distinct cells", () => {
    const got = randomN(3)(G, seq([0.1, 0.5, 0.9, 0.2]));
    expect(got).toHaveLength(3);
    expect(new Set(keys(got)).size).toBe(3);
  });

  test("randomN refuses to under-deliver", () => {
    // The whole point: a directive priced 3 cells into its RTP.
    expect(() => randomN(5, col(0))(G, seq([0.5]))).toThrow(/only 2/);
    expect(() => randomN(1, holding("Z"))(G, seq([0.5]))).toThrow(/only 0/);
  });

  test("randomN rejects a nonsense n at build time, not spin time", () => {
    expect(() => randomN(-1)).toThrow(/non-negative integer/);
    expect(() => randomN(1.5)).toThrow(/non-negative integer/);
  });

  test("upTo takes what is there when the selection is short", () => {
    expect(upTo(5, col(0))(G, seq([0.5, 0.5]))).toHaveLength(2);
    expect(upTo(5, holding("Z"))(G, seq([0.5]))).toEqual([]);
  });

  test("oneOf gives one cell, or none from an empty selection", () => {
    expect(oneOf(col(1))(G, seq([0.4]))).toHaveLength(1);
    expect(oneOf(holding("Z"))(G, seq([0.4]))).toEqual([]);
  });

  test("draws are reproducible for the same rng stream", () => {
    const s = [0.13, 0.77, 0.41];
    expect(keys(randomN(3)(G, seq(s)))).toEqual(keys(randomN(3)(G, seq(s))));
  });

  test("draws consume exactly one value per cell", () => {
    let calls = 0;
    randomN(3)(G, () => { calls++; return 0.5; });
    expect(calls).toBe(3);
    calls = 0;
    upTo(0)(G, () => { calls++; return 0.5; });
    expect(calls).toBe(0);
  });

  test("an rng returning exactly 1 cannot index past the end", () => {
    // Math.floor(1 * span) === span, one past the last valid index.
    const got = randomN(2, col(1))(G, () => 1);
    expect(got).toHaveLength(2);
    expect(new Set(keys(got)).size).toBe(2);
    for (const p of got) expect(p).toBeDefined();
  });

  test("every cell in the pool is reachable", () => {
    // A partial Fisher-Yates that swapped wrongly would leave some cells
    // permanently unreachable while still returning the right COUNT.
    const g = makeGrid(rect(2, 2), ({ col: c, row: r }) => `${c}${r}`);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(key(oneOf()(g, seq([i / 400]))[0]!));
    }
    expect(seen.size).toBe(4);
  });

  test("draws are uniform over the pool", () => {
    const g = makeGrid(rect(2, 2), ({ col: c, row: r }) => `${c}${r}`);
    const counts = new Map<string, number>();
    const N = 40_000;
    for (let i = 0; i < N; i++) {
      const k = key(oneOf()(g, seq([i / N]))[0]!);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [, n] of counts) expect(n / N).toBeCloseTo(0.25, 2);
  });
});

describe("countSelected", () => {
  test("counts without caring which", () => {
    expect(countSelected(holding("A"), G, NO_RNG)).toBe(4);
    expect(countSelected(all(), G, NO_RNG)).toBe(7);
  });
});
