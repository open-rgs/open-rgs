// The smallest evaluator with the largest effect on a game's shape: this is
// almost always what triggers the feature, and feature frequency is usually the
// single biggest term in RTP. So the tests here are mostly about the one rule
// that could quietly inflate it - a wild must never count.

import { describe, expect, test } from "bun:test";
import { fromColumns, makeGrid, rect } from "@open-rgs/grid";
import { paytable, totalMultiplier, type Roles } from "@open-rgs/paytable";
import { countAnywhere, evalAnywhere, evalScatters, shortOfTrigger, triggersOn } from "../src/index.js";

const PAY = paytable({ SC: { 3: 5, 4: 20, 5: 100 }, BONUS: { 3: 2 }, HIGH: { 3: 10 } });
const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC", "BONUS"] };
const X = "BLANK";

function board(rows: string[][]) {
  const cols: string[][] = [];
  for (let c = 0; c < rows[0]!.length; c++) cols.push(rows.map((r) => r[c]!));
  return fromColumns(cols);
}

describe("counting", () => {
  test("counts anywhere, ignoring position", () => {
    const g = board([
      ["SC", X, X, X, X],
      [X, X, "SC", X, X],
      [X, X, X, X, "SC"],
    ]);
    expect(countAnywhere(g, "SC")).toBe(3);
    expect(evalAnywhere(g, "SC", PAY)?.multiplier).toBe(5);
  });

  test("pays by exact count", () => {
    const g = board([
      ["SC", "SC", "SC", "SC", "SC"],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(evalAnywhere(g, "SC", PAY)?.count).toBe(5);
    expect(evalAnywhere(g, "SC", PAY)?.multiplier).toBe(100);
  });

  test("a count with no entry pays nothing", () => {
    const g = board([
      ["SC", "SC", X, X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(countAnywhere(g, "SC")).toBe(2);
    expect(evalAnywhere(g, "SC", PAY)).toBeUndefined();
  });

  test("absent symbol counts zero", () => {
    const g = makeGrid(rect(5, 3), () => X);
    expect(countAnywhere(g, "SC")).toBe(0);
    expect(evalAnywhere(g, "SC", PAY)).toBeUndefined();
  });
});

describe("wilds never count", () => {
  test("a wild does not substitute for a scatter", () => {
    // Two real scatters plus a wild is TWO, not three - otherwise wilds
    // manufacture triggers and the balanced trigger rate is not the shipped one.
    const g = board([
      ["SC", "WILD", "SC", X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(countAnywhere(g, "SC")).toBe(2);
    expect(evalAnywhere(g, "SC", PAY)).toBeUndefined();
  });

  test("a board full of wilds triggers nothing", () => {
    const g = makeGrid(rect(5, 3), () => "WILD");
    expect(triggersOn(g, "SC", 3)).toBe(false);
    expect(evalScatters(g, PAY, { roles: ROLES })).toEqual([]);
  });
});

describe("multiple scatters", () => {
  test("each declared scatter pays on its own count", () => {
    const g = board([
      ["SC", "SC", "SC", X, X],
      ["BONUS", "BONUS", "BONUS", X, X],
      [X, X, X, X, X],
    ]);
    const wins = evalScatters(g, PAY, { roles: ROLES });
    expect(wins.map((w) => w.symbol).sort()).toEqual(["BONUS", "SC"]);
    expect(totalMultiplier(wins)).toBe(7);
  });

  test("a symbol not declared a scatter is not evaluated here", () => {
    const g = board([
      ["HIGH", "HIGH", "HIGH", X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(evalScatters(g, PAY, { roles: ROLES })).toEqual([]);
  });

  test("no scatters declared means nothing to pay", () => {
    const g = board([["SC", "SC", "SC", X, X], [X, X, X, X, X], [X, X, X, X, X]]);
    expect(evalScatters(g, PAY, {})).toEqual([]);
  });
});

describe("triggering is separate from paying", () => {
  test("a game can trigger on a count that pays nothing", () => {
    // Plenty of games trigger on 3 while paying nothing for them.
    const p = paytable({ SC: { 5: 10 } });
    const g = board([
      ["SC", "SC", "SC", X, X],
      [X, X, X, X, X],
      [X, X, X, X, X],
    ]);
    expect(triggersOn(g, "SC", 3)).toBe(true);
    expect(evalAnywhere(g, "SC", p)).toBeUndefined();
  });

  test("shortOfTrigger is the number a tease is built around", () => {
    const two = board([["SC", "SC", X, X, X], [X, X, X, X, X], [X, X, X, X, X]]);
    expect(shortOfTrigger(two, "SC", 3)).toBe(1);
    const three = board([["SC", "SC", "SC", X, X], [X, X, X, X, X], [X, X, X, X, X]]);
    expect(shortOfTrigger(three, "SC", 3)).toBe(0);
    expect(triggersOn(three, "SC", 3)).toBe(true);
  });

  test("more than the minimum still triggers", () => {
    const g = board([["SC", "SC", "SC", "SC", "SC"], [X, X, X, X, X], [X, X, X, X, X]]);
    expect(triggersOn(g, "SC", 3)).toBe(true);
    expect(shortOfTrigger(g, "SC", 3)).toBe(0);
  });
});

describe("positions", () => {
  test("reports which cells counted", () => {
    const g = board([
      ["SC", X, X, X, X],
      [X, X, "SC", X, X],
      [X, X, X, X, "SC"],
    ]);
    const w = evalAnywhere(g, "SC", PAY);
    expect(w?.positions).toHaveLength(3);
    expect(new Set(w?.positions).size).toBe(3);
  });
});
