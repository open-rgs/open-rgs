// Each of these mechanics has exactly one ordering or combination rule that
// decides whether the game is priced right. Those rules are what is tested.

import { describe, expect, test } from "bun:test";
import { fromColumns, makeGrid, rect, toColumns, type Grid } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import {
  applyWalkers, countInColumn, factorAt, noFactors, revealMystery, splits, stepWalkers,
  transform, transformAll, upgradeLadder, waysWithSplits, winFactor, withFactor,
} from "../src/index.js";

const ONE = sampler([{ item: "HIGH", weight: 1 }]);

describe("mystery tiles", () => {
  test("every tile reveals the same symbol by default", () => {
    const g = fromColumns([["M", "LOW"], ["M", "M"]]);
    const out = revealMystery(g, "M", ONE, () => 0.5);
    expect(out.revealed).toBe("HIGH");
    expect(out.cells).toHaveLength(3);
    expect(toColumns(out.grid)).toEqual([["HIGH", "LOW"], ["HIGH", "HIGH"]]);
  });

  test("shared: false draws one per tile", () => {
    const two = sampler([{ item: "A", weight: 1 }, { item: "B", weight: 1 }]);
    const g = fromColumns([["M", "M"]]);
    const seq = [0.1, 0.9];
    let i = 0;
    const out = revealMystery(g, "M", two, () => seq[i++]!, { shared: false });
    expect(new Set(out.grid.cells).size).toBe(2);
    expect(out.revealed).toBeUndefined();
  });

  test("a board with no mystery tile is returned untouched", () => {
    const g = fromColumns([["A", "B"]]);
    const out = revealMystery(g, "M", ONE, () => 0.5);
    expect(out.grid).toBe(g);
    expect(out.cells).toEqual([]);
  });

  test("a weight spec works as well as a built sampler", () => {
    const g = fromColumns([["M"]]);
    expect(revealMystery(g, "M", { HIGH: 1 }, () => 0.5).revealed).toBe("HIGH");
  });
});

describe("transforms", () => {
  test("replaces every occurrence and reports the cells", () => {
    const g = fromColumns([["LOW", "HIGH"], ["LOW", "LOW"]]);
    const out = transform(g, "LOW", "PREM");
    expect(out.cells).toEqual([0, 2, 3]);
    expect(toColumns(out.grid)).toEqual([["PREM", "HIGH"], ["PREM", "PREM"]]);
  });

  test("order is not a detail: chained transforms compose", () => {
    const g = fromColumns([["LOW", "HIGH"]]);
    // LOW->HIGH then HIGH->WILD turns the lows into wilds as well
    expect(toColumns(transformAll(g, [["LOW", "HIGH"], ["HIGH", "WILD"]]))).toEqual([["WILD", "WILD"]]);
    // the other order leaves the lows alone
    expect(toColumns(transformAll(g, [["HIGH", "WILD"], ["LOW", "HIGH"]]))).toEqual([["HIGH", "WILD"]]);
  });

  test("a ladder upgrades one rung, not all the way to the top", () => {
    const g = fromColumns([["L1", "L2"], ["L3", "L1"]]);
    const out = upgradeLadder(g, ["L1", "L2", "L3", "L4"]);
    expect(toColumns(out)).toEqual([["L2", "L3"], ["L4", "L2"]]);
  });

  test("the top of the ladder stays put rather than wrapping", () => {
    const g = fromColumns([["L4"]]);
    expect(toColumns(upgradeLadder(g, ["L1", "L2", "L3", "L4"]))).toEqual([["L4"]]);
  });
});

describe("walking wilds", () => {
  const board = (): Grid<string> => makeGrid(rect(4, 3), () => "LOW");

  test("a walker is written onto each fresh board", () => {
    const w = [{ pos: { col: 3, row: 1 }, symbol: "WILD", step: -1 }];
    expect(applyWalkers(board(), w).cells[3 * 3 + 1]).toBe("WILD");
  });

  test("stepping moves it one column and keeps it", () => {
    const w = [{ pos: { col: 3, row: 1 }, symbol: "WILD", step: -1 }];
    const moved = stepWalkers(board(), w);
    expect(moved[0]!.pos).toEqual({ col: 2, row: 1 });
  });

  test("a walker that leaves the board is dropped, which is how the feature ends", () => {
    const w = [{ pos: { col: 0, row: 0 }, symbol: "WILD", step: -1 }];
    expect(stepWalkers(board(), w)).toEqual([]);
  });

  test("a ragged column keeps the walker on the board", () => {
    const ragged = fromColumns([["a"], ["b", "c", "d"]]);
    const w = [{ pos: { col: 1, row: 2 }, symbol: "WILD", step: -1 }];
    expect(stepWalkers(ragged, w)[0]!.pos).toEqual({ col: 0, row: 0 });
  });
});

describe("wilds that carry a multiplier", () => {
  const g = makeGrid<string>(rect(3, 3), () => "LOW");

  test("factors on one win multiply, they do not add", () => {
    // two 2x wilds in the same line pay 4x
    let m = withFactor(noFactors(), { col: 0, row: 0 }, 2);
    m = withFactor(m, { col: 1, row: 0 }, 2);
    expect(winFactor(g, m, [0, 3])).toBe(4);
  });

  test("a second factor on the SAME cell multiplies too", () => {
    let m = withFactor(noFactors(), { col: 0, row: 0 }, 2);
    m = withFactor(m, { col: 0, row: 0 }, 3);
    expect(factorAt(m, { col: 0, row: 0 })).toBe(6);
  });

  test("a win that touches no multiplier is unchanged", () => {
    const m = withFactor(noFactors(), { col: 2, row: 2 }, 5);
    expect(winFactor(g, m, [0, 1, 2])).toBe(1);
    expect(winFactor(g, noFactors(), [0, 1, 2])).toBe(1);
  });

  test("a negative factor is refused rather than paying backwards", () => {
    expect(() => withFactor(noFactors(), { col: 0, row: 0 }, -2)).toThrow(/non-negative/);
  });
});

describe("symbols that count more than once", () => {
  const counts = splits([["A2", 2]]);
  const isA = (s: string) => s === "A" || s === "A2";

  test("a split counts twice in its column", () => {
    const g = fromColumns([["A", "A2", "LOW"]]);
    expect(countInColumn(g, 0, isA, counts)).toBe(3);
  });

  test("ways double when a split lands, which pay-ways cannot see on its own", () => {
    const plain = fromColumns([["A", "LOW"], ["A", "LOW"], ["A", "LOW"]]);
    const split = fromColumns([["A2", "LOW"], ["A", "LOW"], ["A", "LOW"]]);
    expect(waysWithSplits(plain, isA, counts)).toEqual({ ways: 1, columns: 3 });
    expect(waysWithSplits(split, isA, counts)).toEqual({ ways: 2, columns: 3 });
  });

  test("the run still has to start at column 0", () => {
    const g = fromColumns([["LOW"], ["A"], ["A"]]);
    expect(waysWithSplits(g, isA, counts)).toEqual({ ways: 0, columns: 0 });
  });

  test("a split that counts less than once is an authoring error", () => {
    expect(() => splits([["A", 0]])).toThrow(/at least once/);
  });
});
