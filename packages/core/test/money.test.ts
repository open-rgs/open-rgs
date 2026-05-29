// C1  - money is integer minor units (ADR-002). A win is multiplier (float)
// x bet (int), generally fractional, and must be rounded half-to-even at
// the one boundary before it reaches a wallet. These tests pin the
// rounding rule and the integer guarantee.

import { describe, expect, test } from "bun:test";
import { roundHalfEven, settleAmount, assertSafeAmount } from "../src/money.js";
import { RGSError } from "@open-rgs/contract";

describe("roundHalfEven  - banker's rounding (C1 / ADR-002)", () => {
  test("rounds toward the even neighbour on exact .5 ties", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(3.5)).toBe(4);
    expect(roundHalfEven(12.5)).toBe(12); // the audit's 0.5x25 case
    expect(roundHalfEven(13.5)).toBe(14);
  });

  test("rounds normally when not a tie", () => {
    expect(roundHalfEven(12.4)).toBe(12);
    expect(roundHalfEven(12.6)).toBe(13);
    expect(roundHalfEven(0.4)).toBe(0);
    expect(roundHalfEven(0.6)).toBe(1);
  });

  test("integers pass through unchanged", () => {
    expect(roundHalfEven(200)).toBe(200);
    expect(roundHalfEven(0)).toBe(0);
  });

  test("handles negatives consistently (ties to even)", () => {
    expect(roundHalfEven(-0.5)).toBe(0);
    expect(roundHalfEven(-1.5)).toBe(-2);
    expect(roundHalfEven(-2.5)).toBe(-2);
  });
});

describe("settleAmount  - integer minor units to the wallet (C1)", () => {
  test("the audit's fractional case never reaches the wallet fractional", () => {
    // 0.5 x 25 = 12.5 -> 12 (half-even), an integer
    const win = settleAmount(0.5, 25);
    expect(win).toBe(12);
    expect(Number.isInteger(win)).toBe(true);
  });

  test("exact integer products are unchanged", () => {
    expect(settleAmount(2, 100)).toBe(200);
    expect(settleAmount(5, 100)).toBe(500);
    expect(settleAmount(0, 100)).toBe(0);
  });

  test("result is always an integer across a range of fractional multipliers", () => {
    for (const m of [0.1, 0.33, 0.96, 1.337, 2.5, 9.99]) {
      for (const bet of [1, 5, 25, 100, 333]) {
        expect(Number.isInteger(settleAmount(m, bet))).toBe(true);
      }
    }
  });

  test("throws (fails closed) if a non-finite slips through", () => {
    expect(() => settleAmount(NaN, 100)).toThrow(RGSError);
    expect(() => settleAmount(Infinity, 100)).toThrow(RGSError);
  });

  test("throws (fails closed) on a win past the safe-integer range (H1)", () => {
    // A huge multiplier x bet that lands beyond 2^53 would silently lose
    // precision as a float  - reject it rather than corrupt the ledger.
    expect(() => settleAmount(1e12, 1e6)).toThrow(RGSError);
  });
});

describe("assertSafeAmount  - the safe-integer money guard (H1)", () => {
  test("accepts non-negative safe integers (including the boundary)", () => {
    expect(() => assertSafeAmount(0, "x")).not.toThrow();
    expect(() => assertSafeAmount(100, "x")).not.toThrow();
    expect(() => assertSafeAmount(Number.MAX_SAFE_INTEGER, "x")).not.toThrow();
  });

  test("rejects amounts past 2^53 (the first unsafe integer)", () => {
    expect(() => assertSafeAmount(Number.MAX_SAFE_INTEGER + 1, "x")).toThrow(RGSError);
    expect(() => assertSafeAmount(2 ** 53, "balance")).toThrow(/safe range/);
  });

  test("rejects negatives, fractions and non-finite values", () => {
    expect(() => assertSafeAmount(-1, "x")).toThrow(RGSError);
    expect(() => assertSafeAmount(1.5, "x")).toThrow(RGSError);
    expect(() => assertSafeAmount(NaN, "x")).toThrow(RGSError);
    expect(() => assertSafeAmount(Infinity, "x")).toThrow(RGSError);
  });

  test("the error names the amount for diagnosis", () => {
    expect(() => assertSafeAmount(-5, "win")).toThrow(/win/);
  });
});
