// L2  - naive left-to-right summation drifts over the 10^8+ samples a real
// RTP run produces. mean/stdDev now use Kahan compensated summation.

import { describe, expect, test } from "bun:test";
import { mean, stdDev, percentileSorted } from "../src/stats.js";

describe("stats Kahan summation (L2)", () => {
  test("mean accumulates many sub-ULP values that naive summation drops", () => {
    // 1.0 then 1e6 additions of 1e-16. Each 1e-16 is below ULP(1.0), so naive
    // left-to-right summation drops every one and stays at 1.0; Kahan carries
    // the lost bits forward and recovers the ~1e-10 total.
    const xs = [1.0, ...new Array<number>(1_000_000).fill(1e-16)];
    const naive = xs.reduce((a, b) => a + b, 0);
    const kahanSum = mean(xs) * xs.length;
    expect(naive).toBe(1.0);                       // naive lost it all
    expect(kahanSum).toBeGreaterThan(1.00000000005); // Kahan recovered ~1e-10
  });

  test("mean of a simple set is exact", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBe(0);
  });

  test("stdDev is stable and correct on a simple set", () => {
    // population stddev of [2,4,6] (mean 4) = sqrt((4+0+4)/3) = sqrt(8/3)
    expect(stdDev([2, 4, 6])).toBeCloseTo(Math.sqrt(8 / 3), 10);
    expect(stdDev([])).toBe(0);
  });

  test("percentileSorted unchanged", () => {
    expect(percentileSorted([1, 2, 3, 4], 50)).toBe(2);
  });
});
