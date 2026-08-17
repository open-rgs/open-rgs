// Clusters are mostly a flood fill, and the flood fill is mostly right by
// accident. The cases that separate a correct implementation from a plausible
// one all involve wilds - a wild belongs to EVERY cluster it touches, so
// consuming it for the first symbol silently shrinks the second.

import { describe, expect, test } from "bun:test";
import { fromColumns, makeGrid, rect } from "@open-rgs/grid";
import { paytable, totalMultiplier, type Roles } from "@open-rgs/paytable";
import { clustersOf, evalAllClusters, evalClusters, largestCluster } from "../src/index.js";

const PAY = paytable({
  HIGH: { 3: 5, 4: 10, 5: 20, 6: 40, 8: 100, 15: 500 },
  LOW: { 3: 1, 4: 2, 5: 4, 6: 8 },
  WILD: { 3: 1 },
  SC: { 3: 5 },
});
const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC"] };
const X = "BLANK";

/** Row-major picture -> grid, so a test reads like the board. */
function board(rows: string[][]) {
  const cols: string[][] = [];
  for (let c = 0; c < rows[0]!.length; c++) cols.push(rows.map((r) => r[c]!));
  return fromColumns(cols);
}

describe("connectivity", () => {
  test("orthogonally adjacent cells form one cluster", () => {
    const g = board([
      ["HIGH", "HIGH", X],
      ["HIGH", X, X],
      [X, X, X],
    ]);
    const groups = clustersOf(g, "HIGH", ROLES);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  test("diagonals do NOT connect", () => {
    // Two separate clusters of one, not a cluster of two.
    const g = board([
      ["HIGH", X, X],
      [X, "HIGH", X],
      [X, X, X],
    ]);
    expect(clustersOf(g, "HIGH", ROLES)).toHaveLength(2);
  });

  test("separated groups stay separate", () => {
    const g = board([
      ["HIGH", "HIGH", X, "HIGH", "HIGH"],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    const groups = clustersOf(g, "HIGH", ROLES);
    expect(groups).toHaveLength(2);
    expect(groups.map((x) => x.length)).toEqual([2, 2]);
  });

  test("a whole board is one cluster", () => {
    const g = makeGrid(rect(5, 3), () => "HIGH");
    const groups = clustersOf(g, "HIGH", ROLES);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(15);
  });
});

describe("wilds", () => {
  test("a wild joins a cluster", () => {
    const g = board([
      ["HIGH", "WILD", "HIGH"],
      [X, X, X],
      [X, X, X],
    ]);
    expect(clustersOf(g, "HIGH", ROLES)[0]).toHaveLength(3);
  });

  test("a wild belongs to EVERY cluster it touches", () => {
    // The bug this guards: consuming the wild for HIGH would leave LOW with a
    // cluster of 2 instead of 3, and nothing would look wrong on the board.
    const g = board([
      ["HIGH", "HIGH", "WILD", "LOW", "LOW"],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(clustersOf(g, "HIGH", ROLES)[0]).toHaveLength(3);
    expect(clustersOf(g, "LOW", ROLES)[0]).toHaveLength(3);

    const wins = evalAllClusters(g, PAY, { roles: ROLES });
    expect(wins.map((w) => w.symbol).sort()).toEqual(["HIGH", "LOW"]);
    expect(totalMultiplier(wins)).toBe(6); // HIGH 3 = 5, LOW 3 = 1
  });

  test("a cluster is never SEEDED from a wild", () => {
    // Growing a cluster around a symbol that is not actually present would
    // invent wins out of a lone wild.
    const g = board([
      ["WILD", "WILD", "WILD"],
      [X, X, X],
      [X, X, X],
    ]);
    expect(clustersOf(g, "HIGH", ROLES)).toEqual([]);
    expect(evalClusters(g, "HIGH", PAY, { roles: ROLES })).toEqual([]);
  });

  test("wilds pay nothing on their own", () => {
    // With no real symbol to be, there is no paytable row to read.
    const g = makeGrid(rect(5, 3), () => "WILD");
    expect(evalAllClusters(g, PAY, { roles: ROLES })).toEqual([]);
  });

  test("a wild bridges two groups of the same symbol into one", () => {
    const g = board([
      ["HIGH", "WILD", "HIGH", X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    const groups = clustersOf(g, "HIGH", ROLES);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });
});

describe("payouts", () => {
  test("pays by cluster size", () => {
    const g = board([
      ["HIGH", "HIGH", "HIGH", "HIGH", X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    const wins = evalClusters(g, "HIGH", PAY, { roles: ROLES });
    expect(wins).toHaveLength(1);
    expect(wins[0]!.count).toBe(4);
    expect(wins[0]!.multiplier).toBe(10);
  });

  test("each cluster pays separately", () => {
    const g = board([
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", X, X],
    ]);
    const wins = evalClusters(g, "HIGH", PAY, { roles: ROLES });
    expect(wins).toHaveLength(2);
    expect(totalMultiplier(wins)).toBe(10);
  });

  test("a cluster below the minimum does not pay", () => {
    const g = board([
      ["HIGH", "HIGH", X, X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(evalClusters(g, "HIGH", PAY, { roles: ROLES })).toEqual([]);
  });

  test("a size with no paytable entry pays nothing", () => {
    // 7 is absent from the HIGH table; there is no interpolation.
    const g = board([
      ["HIGH", "HIGH", "HIGH", "HIGH", X],
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
    ]);
    expect(clustersOf(g, "HIGH", ROLES)[0]).toHaveLength(7);
    expect(evalClusters(g, "HIGH", PAY, { roles: ROLES })).toEqual([]);
  });

  test("minSize can override the paytable minimum", () => {
    const g = board([
      ["HIGH", "HIGH", X, X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    const p = paytable({ HIGH: { 2: 1, 3: 5 } });
    expect(evalClusters(g, "HIGH", p, { roles: ROLES, minSize: 2 })).toHaveLength(1);
    expect(evalClusters(g, "HIGH", p, { roles: ROLES, minSize: 3 })).toEqual([]);
  });

  test("scatters are not clustered", () => {
    const g = board([
      ["SC", "SC", "SC", X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(evalClusters(g, "SC", PAY, { roles: ROLES })).toEqual([]);
  });
});

describe("ragged grids", () => {
  test("a short column limits adjacency", () => {
    // Column 1 has no row 2, so the bottom cells of columns 0 and 2 are not
    // connected through it.
    const g = fromColumns([
      ["HIGH", "BLANK", "HIGH"],
      ["BLANK", "BLANK"],
      ["HIGH", "BLANK", "HIGH"],
    ]);
    const groups = clustersOf(g, "HIGH", ROLES);
    expect(groups).toHaveLength(4);
  });

  test("largestCluster reports the biggest group", () => {
    const g = board([
      ["HIGH", "HIGH", "HIGH", X, "HIGH"],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(largestCluster(g, "HIGH", ROLES)).toBe(3);
    expect(largestCluster(g, "LOW", ROLES)).toBe(0);
  });
});
