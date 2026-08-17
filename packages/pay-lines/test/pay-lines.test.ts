// Every test here is a way a payline evaluator can be wrong while still
// looking right on a happy-path board. Each of these is worth real money:
// paying every prefix roughly doubles RTP, misreading a wild-only run
// underpays the best board in the game, and a wild that substitutes for a
// scatter rewrites feature frequency.

import { describe, expect, test } from "bun:test";
import { fromColumns, rect } from "@open-rgs/grid";
import { paytable, totalMultiplier, type Roles } from "@open-rgs/paytable";
import { evalLine, evalLines, rowLines } from "../src/index.js";

const PAY = paytable({
  HIGH: { 3: 10, 4: 50, 5: 200 },
  LOW: { 3: 2, 4: 5, 5: 20 },
  WILD: { 3: 20, 4: 100, 5: 500 },
  SC: { 3: 5 },
});
const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC"] };
const MID = [1, 1, 1, 1, 1];

/** 5x3 from a row-major picture, so tests read like the board looks. */
function board(rows: string[][]) {
  const cols: string[][] = [];
  for (let c = 0; c < rows[0]!.length; c++) cols.push(rows.map((r) => r[c]!));
  return fromColumns(cols);
}

/** Filler that is NOT in the paytable. Using a paying symbol as filler makes
 *  every "unrelated" row a 5-of-a-kind win, which reads as an evaluator bug. */
const X = "BLANK";

describe("basic runs", () => {
  test("three of a kind on the middle row", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.symbol).toBe("HIGH");
    expect(w?.count).toBe(3);
    expect(w?.multiplier).toBe(10);
  });

  test("five of a kind pays the five-count, not the three", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", "HIGH", "HIGH"],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY, { roles: ROLES })?.multiplier).toBe(200);
  });

  test("a line pays ONCE, for its longest run", () => {
    // Paying 3-of-a-kind AND 4 AND 5 on the same run roughly doubles RTP.
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", "HIGH", "HIGH"],
      [X, X, X, X, X],
    ]);
    const wins = evalLines(g, [MID], PAY, { roles: ROLES });
    expect(wins).toHaveLength(1);
    expect(totalMultiplier(wins)).toBe(200);
  });

  test("two of a kind does not pay when the table starts at three", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", X, X, X],
      [X, X, X, X, X],
    ]);
    // BLANK breaks the run at position 2, so it is HIGH x2 - no entry.
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });

  test("a run must start at the leftmost column", () => {
    // Left-to-right games do not pay a run floating in the middle.
    const g = board([
      [X, X, X, X, X],
      ["MID", "HIGH", "HIGH", "HIGH", X],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });
});

describe("wilds", () => {
  test("substitute to extend a run", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "WILD", "HIGH", X, X],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.symbol).toBe("HIGH");
    expect(w?.count).toBe(3);
  });

  test("a wild-only opening pays whichever reading is worth more", () => {
    // WILD WILD LOW LOW LOW reads as either 5 LOW (20) or 2 WILD (nothing).
    const g = board([
      [X, X, X, X, X],
      ["WILD", "WILD", "LOW", "LOW", "LOW"],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.symbol).toBe("LOW");
    expect(w?.count).toBe(5);
    expect(w?.multiplier).toBe(20);
  });

  test("...and keeps the wild reading when THAT is worth more", () => {
    // WILD WILD WILD LOW LOW: 3 WILD pays 20, 5 LOW pays 20 - but
    // WILD WILD WILD WILD LOW is 4 WILD (100) vs 5 LOW (20).
    const g = board([
      [X, X, X, X, X],
      ["WILD", "WILD", "WILD", "WILD", "LOW"],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.symbol).toBe("WILD");
    expect(w?.count).toBe(4);
    expect(w?.multiplier).toBe(100);
  });

  test("an all-wild line pays the wild's own top count", () => {
    const g = board([
      [X, X, X, X, X],
      ["WILD", "WILD", "WILD", "WILD", "WILD"],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.symbol).toBe("WILD");
    expect(w?.multiplier).toBe(500);
  });
});

describe("scatters", () => {
  test("never pay on a line - they pay on total count elsewhere", () => {
    const g = board([
      [X, X, X, X, X],
      ["SC", "SC", "SC", X, X],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });

  test("a wild NEVER substitutes for a scatter", () => {
    // Otherwise wilds manufacture feature triggers, and feature frequency is
    // usually the single biggest term in a game's RTP.
    const g = board([
      [X, X, X, X, X],
      ["SC", "WILD", "SC", X, X],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });

  test("a wild-opening run never reads ITSELF as a scatter", () => {
    const g = board([
      [X, X, X, X, X],
      ["WILD", "SC", "SC", "SC", "SC"],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    // Only "1 WILD" is available, which does not pay.
    expect(w).toBeUndefined();
  });
});

describe("both ways", () => {
  const g = board([
    [X, X, X, X, X],
    [X, X, "HIGH", "HIGH", "HIGH"],
    [X, X, X, X, X],
  ]);

  test("a right-anchored run does not pay left-to-right", () => {
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });

  test("...and does pay with bothWays", () => {
    const w = evalLine(g, MID, PAY, { roles: ROLES, bothWays: true });
    expect(w?.symbol).toBe("HIGH");
    expect(w?.count).toBe(3);
  });

  test("the two directions COMPETE rather than accumulate", () => {
    // A run spanning the whole grid qualifies from both ends; paying both
    // would double-count it.
    const full = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", "HIGH", "HIGH"],
      [X, X, X, X, X],
    ]);
    const wins = evalLines(full, [MID], PAY, { roles: ROLES, bothWays: true });
    expect(wins).toHaveLength(1);
    expect(totalMultiplier(wins)).toBe(200);
  });
});

describe("multiple lines", () => {
  test("each line pays independently", () => {
    const g = board([
      ["HIGH", "HIGH", "HIGH", X, X],
      ["LOW", "LOW", "LOW", X, X],
      [X, X, X, X, X],
    ]);
    const wins = evalLines(g, rowLines(5, 3), PAY, { roles: ROLES });
    expect(wins).toHaveLength(2);
    expect(totalMultiplier(wins)).toBe(12); // 10 + 2
    expect(wins.map((w) => w.line)).toEqual([0, 1]);
  });

  test("rowLines builds one straight line per row", () => {
    expect(rowLines(3, 2)).toEqual([[0, 0, 0], [1, 1, 1]]);
  });

  test("positions report which cells paid", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
    ]);
    const w = evalLine(g, MID, PAY, { roles: ROLES });
    expect(w?.positions).toHaveLength(3);
    expect(new Set(w?.positions).size).toBe(3);
  });
});

describe("ragged grids", () => {
  test("a line ends where the reel is too short", () => {
    // Column 2 has only 2 rows, so a middle-row line [1,1,1] survives, but a
    // bottom-row line [2,2,2] stops at column 2.
    const g = fromColumns([
      ["HIGH", "HIGH", "HIGH"],
      ["HIGH", "HIGH", "HIGH"],
      ["HIGH", "HIGH"],
    ]);
    expect(evalLine(g, [2, 2, 2], PAY, { roles: ROLES })).toBeUndefined(); // run of 2
    expect(evalLine(g, [1, 1, 1], PAY, { roles: ROLES })?.count).toBe(3);
  });

  test("a line longer than the grid is truncated, not an error", () => {
    const g = fromColumns([["HIGH"], ["HIGH"], ["HIGH"]]);
    expect(evalLine(g, [0, 0, 0, 0, 0], PAY, { roles: ROLES })?.count).toBe(3);
  });
});

describe("degenerate input", () => {
  test("no roles at all still evaluates plain runs", () => {
    const g = board([
      [X, X, X, X, X],
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY)?.multiplier).toBe(10);
  });

  test("an empty line list pays nothing", () => {
    const g = board([[X, X, X, X, X], [X, X, X, X, X], [X, X, X, X, X]]);
    expect(evalLines(g, [], PAY, { roles: ROLES })).toEqual([]);
    expect(totalMultiplier([])).toBe(0);
  });

  test("a symbol absent from the paytable pays nothing", () => {
    const g = board([
      [X, X, X, X, X],
      ["GHOST", "GHOST", "GHOST", X, X],
      [X, X, X, X, X],
    ]);
    expect(evalLine(g, MID, PAY, { roles: ROLES })).toBeUndefined();
  });
});

describe("paytable itself", () => {
  test("rejects authoring slips at build time", () => {
    expect(() => paytable({ A: { 0: 5 } })).toThrow(/non-positive count/);
    expect(() => paytable({ A: { 3: -1 } })).toThrow(/invalid payout/);
    expect(() => paytable({ A: { 3: Infinity } })).toThrow(/invalid payout/);
  });

  test("a zero payout is legal and documents a real outcome", () => {
    const p = paytable({ A: { 2: 0, 3: 5 } });
    expect(p.pay("A", 2)).toBe(0);
    expect(p.minCount("A")).toBe(3); // smallest count that actually pays
    expect(p.maxCount("A")).toBe(3);
  });

  test("reports its own shape", () => {
    expect(PAY.best("HIGH")).toBe(200);
    expect(PAY.pay("HIGH", 9)).toBe(0);
    expect(PAY.symbols).toContain("WILD");
  });
});
