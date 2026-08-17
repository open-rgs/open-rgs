// Multiways is mostly "draw the shape per spin", which the ragged-first grid
// already supports - so the interesting tests are not that it works, but that
// the PRICING is right.
//
// The trap: board ways and win ways are different numbers, and rescaling a
// fixed-height paytable by E[ways] gets the game wrong. The analytic below is
// checked against a Monte-Carlo run of the real evaluator, which is the only
// way to know a closed form is the closed form of the thing you shipped.

import { describe, expect, test } from "bun:test";
import { column, sizeOf, widthOf } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import { paytable, type Roles } from "@open-rgs/paytable";
import { evalWay } from "@open-rgs/pay-ways";
import {
  expectedMatches, expectedWays, expectedWaysPayout, heights, maxWays, minWays,
  multiwaysFill, multiwaysFillWeights, probNoMatch, waysOf,
} from "../src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPEC = { 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 };
const H6 = heights(SPEC, 6);

describe("drawing heights", () => {
  test("one height per reel, all in range", () => {
    const next = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const shape = H6.draw(next);
      expect(shape).toHaveLength(6);
      for (const h of shape) {
        expect(h).toBeGreaterThanOrEqual(2);
        expect(h).toBeLessThanOrEqual(7);
      }
    }
  });

  test("consumes exactly one float per reel", () => {
    let calls = 0;
    H6.draw(() => { calls++; return 0.5; });
    expect(calls).toBe(6);
  });

  test("per-reel specs let the outer reels differ", () => {
    const h = heights([{ 2: 1 }, { 7: 1 }, { 4: 1 }]);
    expect(h.draw(() => 0.5)).toEqual([2, 7, 4]);
    expect(h.reels).toBe(3);
  });

  test("rejects a height that is not a positive integer", () => {
    expect(() => heights({ 0: 1 }, 3)).toThrow(/positive integer/);
    expect(() => heights({ "-2": 1 }, 3)).toThrow(/positive integer/);
  });

  test("rejects an empty configuration", () => {
    expect(() => heights([])).toThrow(/spec per reel/);
    expect(() => heights({ 3: 1 })).toThrow(/spec per reel/);
  });

  test("a zero-weight height is never drawn and never counts as the range", () => {
    const h = heights({ 2: 1, 9: 0 }, 2);
    expect(h.range(0)).toEqual({ min: 2, max: 2 });
    const next = mulberry32(7);
    for (let i = 0; i < 300; i++) expect(h.draw(next)).toEqual([2, 2]);
  });
});

describe("ways arithmetic", () => {
  test("waysOf is the product of column heights", () => {
    expect(waysOf([4, 4, 4, 4, 4])).toBe(1024);
    expect(waysOf([3, 3, 3, 3, 3])).toBe(243);
    expect(waysOf([2, 7, 3])).toBe(42);
  });

  test("min and max bound the marketing number", () => {
    expect(minWays(H6)).toBe(2 ** 6);
    expect(maxWays(H6)).toBe(7 ** 6);
  });

  test("expectedWays matches a measured mean, because reels are independent", () => {
    // E[prod] = prod E[] only under independence - which is exactly the
    // assumption a correlated "all reels go tall" feature would break.
    const analytic = expectedWays(H6);
    const next = mulberry32(99);
    const N = 200_000;
    let total = 0;
    for (let i = 0; i < N; i++) total += waysOf(H6.draw(next));
    expect(total / N).toBeCloseTo(analytic, -1);
    expect(Math.abs(total / N - analytic) / analytic).toBeLessThan(0.02);
  });
});

describe("generating boards", () => {
  test("the grid matches the drawn shape", () => {
    const gen = multiwaysFillWeights(H6, { A: 1, B: 1 });
    const next = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const g = gen(next);
      expect(widthOf(g.shape)).toBe(6);
      expect(g.cells).toHaveLength(sizeOf(g.shape));
      for (let c = 0; c < 6; c++) expect(column(g, c)).toHaveLength(g.shape[c]!);
    }
  });

  test("heights are drawn before symbols, so a replay reproduces both", () => {
    const gen = multiwaysFill(H6, sampler({ A: 1, B: 1, C: 1 }));
    const a = gen(mulberry32(42));
    const b = gen(mulberry32(42));
    expect(a.shape).toEqual(b.shape);
    expect(a.cells).toEqual(b.cells);
  });
});

describe("pay-ways works unchanged on a multiways board", () => {
  const PAY = paytable({ HIGH: { 3: 1, 4: 4, 5: 12, 6: 40 } });
  const ROLES: Roles = {};

  test("the ways multiplier is per-column MATCHES, not reel height", () => {
    // This is why pay-ways needed no change: it never reads the shape.
    const gen = multiwaysFillWeights(heights({ 2: 1, 7: 1 }, 3), { HIGH: 1 });
    const next = mulberry32(11);
    for (let i = 0; i < 200; i++) {
      const g = gen(next);
      const w = evalWay(g, "HIGH", PAY, { roles: ROLES });
      // Every cell is HIGH, so matches == height on every reel.
      expect(w?.ways).toBe(waysOf(g.shape));
      expect(w?.count).toBe(3);
    }
  });

  test("a taller board really does pay more for the same run", () => {
    const short = multiwaysFillWeights(heights({ 2: 1 }, 3), { HIGH: 1 })(mulberry32(1));
    const tall = multiwaysFillWeights(heights({ 6: 1 }, 3), { HIGH: 1 })(mulberry32(1));
    const a = evalWay(short, "HIGH", PAY, { roles: ROLES })!;
    const b = evalWay(tall, "HIGH", PAY, { roles: ROLES })!;
    expect(a.ways).toBe(8);    // 2^3
    expect(b.ways).toBe(216);  // 6^3
    expect(b.multiplier).toBe(a.multiplier * 27);
  });
});

describe("pricing - the analytic against the real evaluator", () => {
  const H = heights({ 2: 30, 3: 30, 4: 25, 5: 15 }, 5);
  const P_HIGH = 0.25; // HIGH is 25% of the symbol set
  const PAY = paytable({ HIGH: { 2: 0.5, 3: 2, 4: 8, 5: 30 } });

  test("expectedMatches and probNoMatch agree with simulation", () => {
    const gen = multiwaysFillWeights(H, { HIGH: 1, X: 3 }); // p(HIGH) = 0.25
    const next = mulberry32(5);
    const N = 200_000;
    let matches = 0;
    let empty = 0;
    for (let i = 0; i < N; i++) {
      const col = column(gen(next), 0);
      const m = col.filter((s) => s === "HIGH").length;
      matches += m;
      if (m === 0) empty++;
    }
    expect(matches / N).toBeCloseTo(expectedMatches(H, 0, P_HIGH), 2);
    expect(empty / N).toBeCloseTo(probNoMatch(H, 0, P_HIGH), 2);
  });

  test("expectedWaysPayout matches a Monte-Carlo of evalWay", () => {
    // The whole point of the closed form: it must price the thing that
    // actually runs, not an idealisation of it.
    const analytic = expectedWaysPayout(H, P_HIGH, (k) => PAY.pay("HIGH", k));
    const gen = multiwaysFillWeights(H, { HIGH: 1, X: 3 });
    const next = mulberry32(2024);
    const N = 400_000;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const w = evalWay(gen(next), "HIGH", PAY, { roles: {} });
      if (w) total += w.multiplier;
    }
    const measured = total / N;
    expect(Math.abs(measured - analytic) / analytic).toBeLessThan(0.05);
  });

  test("payout does NOT scale with board ways - it depends on the paytable", () => {
    // The trap this package documents, and the first draft of this test got it
    // backwards. A k-column win carries a multiplier scaling as h^k while the
    // BOARD scales as h^reels, so only a paytable paying exclusively
    // full-length runs tracks board ways. Everything shorter scales slower -
    // and short runs are where most expected value lives.
    const short = heights({ 2: 1 }, 5);
    const tall = heights({ 4: 1 }, 5);
    const waysRatio = expectedWays(tall) / expectedWays(short);
    const ratio = (pay: (k: number) => number) =>
      expectedWaysPayout(tall, P_HIGH, pay) / expectedWaysPayout(short, P_HIGH, pay);

    expect(waysRatio).toBeCloseTo(32, 5);

    // Full-length runs only: tracks board ways EXACTLY.
    expect(ratio((k) => (k === 5 ? 1 : 0))).toBeCloseTo(waysRatio, 5);

    // Short runs scale far slower - a 2-of-a-kind game grows 2.25x, not 32x.
    expect(ratio((k) => (k === 2 ? 1 : 0))).toBeLessThan(3);
    expect(ratio((k) => (k === 3 ? 1 : 0))).toBeLessThan(6);

    // A normal paytable lands between the two, strictly below board ways.
    const mixed = ratio((k) => PAY.pay("HIGH", k));
    expect(mixed).toBeGreaterThan(ratio((k) => (k === 3 ? 1 : 0)));
    expect(mixed).toBeLessThan(waysRatio);
  });

  test("a symbol that cannot land prices at zero", () => {
    expect(expectedWaysPayout(H, 0, (k) => PAY.pay("HIGH", k))).toBe(0);
  });
});
