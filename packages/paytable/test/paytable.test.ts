// The paytable is the one place four evaluators agree about what a symbol is
// worth and what a wild may stand in for. It had no tests of its own: it was
// exercised through pay-lines, pay-ways, pay-anywhere and pay-cluster, which
// means a change here failed somewhere else, or nowhere.

import { describe, expect, test } from "bun:test";
import {
  bands, isScatter, isWild, paytable, substitutes, totalMultiplier, type Roles,
} from "../src/index.js";

const PAY = paytable({ HIGH: { 3: 5, 4: 20, 5: 100 }, LOW: { 3: 1, 4: 2, 5: 8 } });
const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC"] };

describe("what a count pays", () => {
  test("reads back the number that was written", () => {
    expect(PAY.pay("HIGH", 4)).toBe(20);
    expect(PAY.pay("LOW", 5)).toBe(8);
  });

  test("a count with no entry pays nothing", () => {
    expect(PAY.pay("HIGH", 2)).toBe(0);
    expect(PAY.pay("HIGH", 6)).toBe(0);
    expect(PAY.pay("MISSING", 3)).toBe(0);
  });

  test("min, max and best describe the symbol's range", () => {
    expect(PAY.minCount("HIGH")).toBe(3);
    expect(PAY.maxCount("HIGH")).toBe(5);
    expect(PAY.best("HIGH")).toBe(100);
    expect([...PAY.symbols].sort()).toEqual(["HIGH", "LOW"]);
  });

  test("a symbol declared as worth nothing has no minimum", () => {
    const zero = paytable({ DEAD: { 2: 0, 3: 0 } });
    expect(zero.minCount("DEAD")).toBe(0);
    expect(zero.best("DEAD")).toBe(0);
    expect(zero.maxCount("DEAD")).toBe(3);   // an entry exists, it just pays 0
  });
});

describe("what a paytable refuses to build", () => {
  test("a non-positive count", () => {
    expect(() => paytable({ HIGH: { 0: 5 } })).toThrow(/non-positive count/);
  });

  test("a negative or non-finite payout, because a win must not reduce a round", () => {
    expect(() => paytable({ HIGH: { 3: -1 } })).toThrow(/invalid payout/);
    expect(() => paytable({ HIGH: { 3: Infinity } })).toThrow(/invalid payout/);
  });

  test("a gap between paying counts, which would pay the LONGER run nothing", () => {
    expect(() => paytable({ HIGH: { 3: 5, 5: 100 } })).toThrow(/no entry for 4/);
    // and the escape hatch for a game that means it
    expect(paytable({ HIGH: { 3: 5, 5: 100 } }, { allowGaps: true }).pay("HIGH", 4)).toBe(0);
  });

  test("a zero-payout entry closes a gap, which is why it is allowed", () => {
    expect(() => paytable({ HIGH: { 3: 5, 4: 0, 5: 100 } })).not.toThrow();
  });
});

describe("wilds and scatters mean one thing everywhere", () => {
  test("a wild stands in for an ordinary symbol", () => {
    expect(substitutes("WILD", "HIGH", ROLES)).toBe(true);
    expect(isWild("WILD", ROLES)).toBe(true);
  });

  test("a wild never stands in for a scatter", () => {
    // The feature's frequency is usually the largest term in a game's RTP, so
    // a wild that manufactures triggers rewrites it.
    expect(substitutes("WILD", "SC", ROLES)).toBe(false);
    expect(isScatter("SC", ROLES)).toBe(true);
  });

  test("a symbol always stands in for itself, scatter or not", () => {
    expect(substitutes("SC", "SC", ROLES)).toBe(true);
    expect(substitutes("HIGH", "HIGH", ROLES)).toBe(true);
    expect(substitutes("HIGH", "LOW", ROLES)).toBe(false);
  });

  test("with no roles declared, nothing substitutes for anything else", () => {
    expect(substitutes("WILD", "HIGH", {})).toBe(false);
    expect(isWild("WILD", {})).toBe(false);
    expect(isScatter("SC", {})).toBe(false);
  });
});

describe("bands expand a range into the counts an evaluator looks up", () => {
  test("each band fills up to the next one, and the last runs to maxCount", () => {
    const spec = bands({ A: [[5, 1], [9, 5], [12, 20]] }, 14);
    expect(spec["A"]).toEqual({
      5: 1, 6: 1, 7: 1, 8: 1,
      9: 5, 10: 5, 11: 5,
      12: 20, 13: 20, 14: 20,
    });
  });

  test("the result is a table an evaluator can use directly", () => {
    const p = paytable(bands({ A: [[5, 1], [9, 5]] }, 10));
    expect(p.pay("A", 7)).toBe(1);
    expect(p.pay("A", 9)).toBe(5);
    expect(p.pay("A", 4)).toBe(0);
  });

  test("bands are sorted, so they can be written in any order", () => {
    const spec = bands({ A: [[9, 5], [5, 1]] }, 10);
    expect(spec["A"]![5]).toBe(1);
    expect(spec["A"]![9]).toBe(5);
  });

  test("a band that can never be reached is an authoring slip", () => {
    expect(() => bands({ A: [[5, 1], [30, 100]] }, 12)).toThrow(/above maxCount/);
    expect(() => bands({ A: [] }, 12)).toThrow(/no bands/);
    expect(() => bands({ A: [[0, 1]] }, 12)).toThrow(/non-positive band start/);
    expect(() => bands({ A: [[5, 1]] }, 0)).toThrow(/maxCount/);
  });
});

describe("totalling wins", () => {
  test("sums every win's multiplier", () => {
    const wins = [
      { symbol: "HIGH", count: 3, multiplier: 5, positions: [0, 1, 2] },
      { symbol: "LOW", count: 4, multiplier: 2, positions: [3, 4, 5, 6] },
    ];
    expect(totalMultiplier(wins)).toBe(7);
    expect(totalMultiplier([])).toBe(0);
  });
});
