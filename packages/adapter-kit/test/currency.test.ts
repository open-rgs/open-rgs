import { describe, test, expect } from "bun:test";
import { toWireAmount, fromWireAmount } from "../src/currency.js";

describe("toWireAmount", () => {
  test("integer format is identity", () => {
    expect(toWireAmount(15050, 2, "integer")).toBe(15050);
    expect(toWireAmount(0, 2, "integer")).toBe(0);
    expect(toWireAmount(-150, 2, "integer")).toBe(-150);
  });

  test("decimal_string formats minor units into '<whole>.<frac>'", () => {
    expect(toWireAmount(15050, 2, "decimal_string")).toBe("150.50");
    expect(toWireAmount(150, 2, "decimal_string")).toBe("1.50");
    expect(toWireAmount(5, 2, "decimal_string")).toBe("0.05");
    expect(toWireAmount(0, 2, "decimal_string")).toBe("0.00");
  });

  test("decimal_string handles negatives", () => {
    expect(toWireAmount(-150, 2, "decimal_string")).toBe("-1.50");
    expect(toWireAmount(-5, 2, "decimal_string")).toBe("-0.05");
  });

  test("decimal_string with decimals=0 has no decimal point", () => {
    expect(toWireAmount(15050, 0, "decimal_string")).toBe("15050");
    expect(toWireAmount(0, 0, "decimal_string")).toBe("0");
  });

  test("decimal_string for crypto (decimals=8)", () => {
    expect(toWireAmount(100_000_000, 8, "decimal_string")).toBe("1.00000000");
    expect(toWireAmount(1, 8, "decimal_string")).toBe("0.00000001");
  });

  test("float divides by 10^decimals", () => {
    expect(toWireAmount(15050, 2, "float")).toBe(150.5);
    expect(toWireAmount(100, 2, "float")).toBe(1);
  });

  test("rejects non-integer input", () => {
    expect(() => toWireAmount(1.5, 2, "decimal_string")).toThrow(/integer/);
  });

  test("rejects negative decimals", () => {
    expect(() => toWireAmount(100, -1, "decimal_string")).toThrow(/non-negative/);
  });
});

describe("fromWireAmount", () => {
  test("integer format is identity", () => {
    expect(fromWireAmount(15050, 2, "integer")).toBe(15050);
    expect(fromWireAmount(0, 2, "integer")).toBe(0);
  });

  test("integer rejects non-integers", () => {
    expect(() => fromWireAmount(1.5, 2, "integer")).toThrow();
  });

  test("decimal_string parses '<whole>.<frac>' into minor units", () => {
    expect(fromWireAmount("150.50", 2, "decimal_string")).toBe(15050);
    expect(fromWireAmount("1.50", 2, "decimal_string")).toBe(150);
    expect(fromWireAmount("0.05", 2, "decimal_string")).toBe(5);
    expect(fromWireAmount("0.00", 2, "decimal_string")).toBe(0);
    expect(fromWireAmount("0", 2, "decimal_string")).toBe(0);
  });

  test("decimal_string handles negatives", () => {
    expect(fromWireAmount("-1.50", 2, "decimal_string")).toBe(-150);
    expect(fromWireAmount("-0.05", 2, "decimal_string")).toBe(-5);
  });

  test("decimal_string pads short fractional part", () => {
    expect(fromWireAmount("1.5", 2, "decimal_string")).toBe(150);
    expect(fromWireAmount("1", 2, "decimal_string")).toBe(100);
  });

  test("decimal_string applies banker's rounding on excess precision", () => {
    // "1.005" with decimals=2  - tie at 100.5 -> round to even -> 100
    expect(fromWireAmount("1.005", 2, "decimal_string", "half_even")).toBe(100);
    // "1.015" with decimals=2  - tie at 101.5 -> round to even -> 102
    expect(fromWireAmount("1.015", 2, "decimal_string", "half_even")).toBe(102);
    // "1.004"  - round down
    expect(fromWireAmount("1.004", 2, "decimal_string", "half_even")).toBe(100);
    // "1.006"  - round up
    expect(fromWireAmount("1.006", 2, "decimal_string", "half_even")).toBe(101);
  });

  test("decimal_string respects half_up rounding", () => {
    expect(fromWireAmount("1.005", 2, "decimal_string", "half_up")).toBe(101);
    expect(fromWireAmount("1.015", 2, "decimal_string", "half_up")).toBe(102);
    expect(fromWireAmount("-1.005", 2, "decimal_string", "half_up")).toBe(-101);
  });

  test("decimal_string respects floor / ceiling", () => {
    expect(fromWireAmount("1.999", 2, "decimal_string", "floor")).toBe(199);
    expect(fromWireAmount("1.001", 2, "decimal_string", "ceiling")).toBe(101);
    // floor/ceiling are sign-correct (round toward -inf / +inf), not magnitude.
    expect(fromWireAmount("-1.001", 2, "decimal_string", "floor")).toBe(-101);
    expect(fromWireAmount("-1.999", 2, "decimal_string", "ceiling")).toBe(-199);
  });

  test("ties are detected from the string, not a reparsed float (M10)", () => {
    // A tail just BELOW 0.5 that Number('0.'+tail) collapses to exactly 0.5.
    // Correct: it's < 0.5, so half_up rounds DOWN.
    expect(fromWireAmount("1.004999999999999999", 2, "decimal_string", "half_up")).toBe(100);
    // A tail just ABOVE 0.5 that also reparses to 0.5. Correct: > 0.5, so
    // half_down rounds UP.
    expect(fromWireAmount("1.005000000000000001", 2, "decimal_string", "half_down")).toBe(101);
    // An exact half with trailing zeros still ties correctly (half_even).
    expect(fromWireAmount("1.0050000000", 2, "decimal_string", "half_even")).toBe(100);
    expect(fromWireAmount("1.0150000000", 2, "decimal_string", "half_even")).toBe(102);
  });

  test("float multiplies by 10^decimals", () => {
    expect(fromWireAmount(150.5, 2, "float")).toBe(15050);
    expect(fromWireAmount(1, 2, "float")).toBe(100);
  });

  test("rejects malformed decimal strings", () => {
    expect(() => fromWireAmount("abc", 2, "decimal_string")).toThrow(/malformed/);
    expect(() => fromWireAmount("1.2.3", 2, "decimal_string")).toThrow(/malformed/);
    expect(() => fromWireAmount("", 2, "decimal_string")).toThrow(/malformed/);
  });

  test("rejects negative decimals", () => {
    expect(() => fromWireAmount("1.50", -1, "decimal_string")).toThrow(/non-negative/);
  });
});

describe("fromWireAmount rejects amounts past the safe-integer range (H1)", () => {
  // Money is carried as `number`, which loses integer precision past 2^53.
  // A wire amount that converts beyond MAX_SAFE_INTEGER must fail loud rather
  // than silently corrupt the ledger. 9007199254740992 === 2^53 is the first
  // unsafe integer (MAX_SAFE_INTEGER === 2^53 - 1 === 9007199254740991).
  test("decimal_string exact-fit value at 2^53 is rejected", () => {
    // "90071992547409.92" with decimals=2 -> 9007199254740992 === 2^53.
    expect(() => fromWireAmount("90071992547409.92", 2, "decimal_string")).toThrow(/safe integer/);
  });

  test("decimal_string value just below 2^53 is accepted", () => {
    // "90071992547409.91" -> 9007199254740991 === MAX_SAFE_INTEGER.
    expect(fromWireAmount("90071992547409.91", 2, "decimal_string")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("decimal_string rounding path past 2^53 is rejected", () => {
    // Excess precision that rounds up to 2^53.
    expect(() => fromWireAmount("90071992547409.919", 2, "decimal_string", "half_up")).toThrow(/safe integer/);
  });

  test("integer format past 2^53 is rejected", () => {
    expect(() => fromWireAmount(9007199254740992, 0, "integer")).toThrow(/safe integer/);
  });

  test("float format past 2^53 is rejected", () => {
    expect(() => fromWireAmount(1e15, 2, "float")).toThrow(/safe integer/);
  });

  test("negative amount past -2^53 is rejected", () => {
    expect(() => fromWireAmount("-90071992547409.92", 2, "decimal_string")).toThrow(/safe integer/);
  });
});

describe("round-trip identity (minor -> wire -> minor)", () => {
  const cases: Array<[number, number]> = [
    [15050, 2],
    [0, 2],
    [-150, 2],
    [1, 8],          // 1 satoshi
    [100_000_000, 8], // 1 BTC
    [15050, 0],      // JPY-like, no decimals
    [999_999_999, 2],
  ];
  for (const [minor, decimals] of cases) {
    test(`integer roundtrip: ${minor} (decimals=${decimals})`, () => {
      const wire = toWireAmount(minor, decimals, "integer");
      const back = fromWireAmount(wire, decimals, "integer");
      expect(back).toBe(minor);
    });
    test(`decimal_string roundtrip: ${minor} (decimals=${decimals})`, () => {
      const wire = toWireAmount(minor, decimals, "decimal_string");
      const back = fromWireAmount(wire, decimals, "decimal_string");
      expect(back).toBe(minor);
    });
  }
});
