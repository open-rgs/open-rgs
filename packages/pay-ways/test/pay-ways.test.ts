// Ways games are dense - most spins touch several columns - so the two classic
// bugs are much more expensive here than on paylines: counting non-contiguous
// columns, and paying every prefix of a run.

import { describe, expect, test } from "bun:test";
import { fromColumns, rect, makeGrid } from "@open-rgs/grid";
import { paytable, totalMultiplier, type Roles } from "@open-rgs/paytable";
import { evalWay, evalWays, totalWays } from "../src/index.js";

const PAY = paytable({
  HIGH: { 3: 10, 4: 50, 5: 200 },
  LOW: { 3: 2, 4: 5, 5: 20 },
  WILD: { 3: 20 },
  SC: { 3: 5 },
});
const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC"] };
const X = "BLANK";

const board = (cols: string[][]) => fromColumns(cols);

describe("counting ways", () => {
  test("multiplies per-column counts", () => {
    // 2 x 3 x 1 = 6 ways of three-of-a-kind at 10 = 60
    const g = board([
      ["HIGH", "HIGH", X],
      ["HIGH", "HIGH", "HIGH"],
      ["HIGH", X, X],
      [X, X, X],
      [X, X, X],
    ]);
    const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
    expect(w?.count).toBe(3);
    expect(w?.ways).toBe(6);
    expect(w?.multiplier).toBe(60);
  });

  test("one per column is one way", () => {
    const g = board([["HIGH", X, X], ["HIGH", X, X], ["HIGH", X, X], [X, X, X], [X, X, X]]);
    const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
    expect(w?.ways).toBe(1);
    expect(w?.multiplier).toBe(10);
  });

  test("a full board of one symbol is every way at the top count", () => {
    const g = makeGrid(rect(5, 3), () => "HIGH");
    const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
    expect(w?.count).toBe(5);
    expect(w?.ways).toBe(243); // 3^5
    expect(w?.multiplier).toBe(200 * 243);
  });
});

describe("contiguity", () => {
  test("a gap ends the run", () => {
    // HIGH on columns 0,1 then a gap then 3,4. Only the first two count, which
    // is below the 3-of-a-kind minimum.
    const g = board([
      ["HIGH", X, X],
      ["HIGH", X, X],
      [X, X, X],
      ["HIGH", X, X],
      ["HIGH", X, X],
    ]);
    expect(evalWay(g, "HIGH", PAY, { roles: ROLES })).toBeUndefined();
  });

  test("columns after a gap do not inflate the ways multiplier", () => {
    // Contiguous 3 columns, then a gap, then more. Counting the later columns
    // would raise BOTH the count and the ways product.
    const g = board([
      ["HIGH", "HIGH", X],
      ["HIGH", X, X],
      ["HIGH", X, X],
      [X, X, X],
      ["HIGH", "HIGH", "HIGH"],
    ]);
    const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
    expect(w?.count).toBe(3);
    expect(w?.ways).toBe(2); // 2 x 1 x 1
  });

  test("a run must start at column 0", () => {
    const g = board([
      [X, X, X],
      ["HIGH", X, X],
      ["HIGH", X, X],
      ["HIGH", X, X],
      [X, X, X],
    ]);
    expect(evalWay(g, "HIGH", PAY, { roles: ROLES })).toBeUndefined();
  });
});

describe("one win per symbol", () => {
  test("a four-column run pays 4-of-a-kind only", () => {
    const g = board([
      ["HIGH", X, X], ["HIGH", X, X], ["HIGH", X, X], ["HIGH", X, X], [X, X, X],
    ]);
    const wins = evalWays(g, PAY, { roles: ROLES });
    const high = wins.filter((w) => w.symbol === "HIGH");
    expect(high).toHaveLength(1);
    expect(high[0]!.multiplier).toBe(50);
  });

  test("different symbols each pay their own run", () => {
    const g = board([
      ["HIGH", "LOW", X], ["HIGH", "LOW", X], ["HIGH", "LOW", X], [X, X, X], [X, X, X],
    ]);
    const wins = evalWays(g, PAY, { roles: ROLES });
    expect(wins.map((w) => w.symbol).sort()).toEqual(["HIGH", "LOW"]);
    expect(totalMultiplier(wins)).toBe(12);
  });
});

describe("wilds and scatters", () => {
  test("wilds count toward a run", () => {
    const g = board([
      ["HIGH", X, X], ["WILD", X, X], ["HIGH", X, X], [X, X, X], [X, X, X],
    ]);
    expect(evalWay(g, "HIGH", PAY, { roles: ROLES })?.count).toBe(3);
  });

  test("a wild adds to the ways product in its column", () => {
    const g = board([
      ["HIGH", "WILD", X], ["HIGH", X, X], ["HIGH", X, X], [X, X, X], [X, X, X],
    ]);
    expect(evalWay(g, "HIGH", PAY, { roles: ROLES })?.ways).toBe(2);
  });

  test("scatters are not evaluated as ways", () => {
    const g = board([
      ["SC", X, X], ["SC", X, X], ["SC", X, X], [X, X, X], [X, X, X],
    ]);
    expect(evalWay(g, "SC", PAY, { roles: ROLES })).toBeUndefined();
    expect(evalWays(g, PAY, { roles: ROLES }).map((w) => w.symbol)).not.toContain("SC");
  });

  test("a wild never manufactures a scatter run", () => {
    const g = board([
      ["SC", X, X], ["WILD", X, X], ["SC", X, X], [X, X, X], [X, X, X],
    ]);
    expect(evalWays(g, PAY, { roles: ROLES }).map((w) => w.symbol)).not.toContain("SC");
  });
});

describe("ragged grids", () => {
  test("totalWays is the product of real column heights", () => {
    expect(totalWays(makeGrid(rect(5, 4), () => X))).toBe(1024);
    expect(totalWays(makeGrid(rect(5, 3), () => X))).toBe(243);
    expect(totalWays(makeGrid([4, 5, 5, 5, 5, 4], () => X))).toBe(4 * 5 * 5 * 5 * 5 * 4);
  });

  test("a short column still contributes its own count", () => {
    const g = fromColumns([
      ["HIGH", "HIGH"],
      ["HIGH", "HIGH", "HIGH"],
      ["HIGH"],
    ]);
    const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
    expect(w?.count).toBe(3);
    expect(w?.ways).toBe(6); // 2 x 3 x 1
  });
});

describe("a wild with its own paytable row", () => {
  // WILD substitutes for HIGH and also pays 3-of-a-kind on its own.
  const pay = paytable({ HIGH: { 3: 10 }, WILD: { 3: 4 } });
  const roles = { wilds: ["WILD"] };
  // Three columns where every cell is a wild: HIGH's run and WILD's run are
  // the SAME three cells.
  const grid = fromColumns([["WILD"], ["WILD"], ["WILD"]]);

  test("does not pay the same cells twice by default", () => {
    const wins = evalWays(grid, pay, { roles });
    expect(wins.map((w) => w.symbol)).toEqual(["HIGH"]);
    expect(wins.reduce((n, w) => n + w.multiplier, 0)).toBe(10);
  });

  test("pays separately only when the game asks for it", () => {
    const wins = evalWays(grid, pay, { roles, wildsPaySeparately: true });
    expect(wins.map((w) => w.symbol).sort()).toEqual(["HIGH", "WILD"]);
    expect(wins.reduce((n, w) => n + w.multiplier, 0)).toBe(14);
  });

  test("evalWay on the wild itself is unchanged - the choice is at the set level", () => {
    expect(evalWay(grid, "WILD", pay, { roles })?.multiplier).toBe(4);
  });
});
