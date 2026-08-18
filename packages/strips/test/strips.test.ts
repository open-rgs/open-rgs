// A strip is a finite object, so its probabilities are arithmetic rather than
// simulation results. The tests that matter are the ones where the obvious
// formula is wrong: a stacked symbol appears several times in one window, so
// "height x per-cell chance" overcounts exactly where a strip game puts its
// stacks.

import { describe, expect, test } from "bun:test";
import { rect, toColumns } from "@open-rgs/grid";
import {
  assertStrips, boardFrom, cellProbability, countOn, drawStops, expectedInWindow,
  longestRun, spinStrips, stripOf, symbolAt, windowAt, windowCountDistribution,
  windowProbability,
} from "../src/index.js";

const REEL = ["A", "B", "C", "D"];
const STACKED = ["W", "W", "W", "L", "L", "L", "L", "L"];   // one 3-tall stack in 8

describe("the window a stop shows", () => {
  test("reads down from the stop", () => {
    expect(windowAt(REEL, 1, 3)).toEqual(["B", "C", "D"]);
  });

  test("wraps, because a reel is a loop", () => {
    expect(windowAt(REEL, 3, 3)).toEqual(["D", "A", "B"]);
    expect(symbolAt(REEL, 4)).toBe("A");
    expect(symbolAt(REEL, -1)).toBe("D");
  });

  test("a board is one window per reel", () => {
    const grid = boardFrom([REEL, REEL], rect(2, 2), [0, 3]);
    expect(toColumns(grid)).toEqual([["A", "B"], ["D", "A"]]);
  });

  test("a spin returns the stops as well as the board, because the stops are the replay", () => {
    const out = spinStrips([REEL, REEL], rect(2, 3), () => 0.5);
    expect(out.stops).toEqual([2, 2]);
    expect(toColumns(out.grid)[0]).toEqual(["C", "D", "A"]);
  });

  test("stops are drawn one float per reel, in reel order", () => {
    const seq = [0, 0.99];
    let i = 0;
    expect(drawStops([REEL, REEL], () => seq[i++]!)).toEqual([0, 3]);
  });
});

describe("what a strip set refuses", () => {
  test("a window taller than its reel, which would show the same symbol twice", () => {
    expect(() => assertStrips([["A", "B"]], rect(1, 3))).toThrow(/window shows 3/);
  });

  test("the wrong number of reels, or an empty one", () => {
    expect(() => assertStrips([REEL], rect(2, 3))).toThrow(/1 reels for a 2-column shape/);
    expect(() => assertStrips([[]], rect(1, 1))).toThrow(/reel 0 is empty/);
    expect(() => assertStrips([], rect(1, 1))).toThrow(/at least one reel/);
  });

  test("a stop list that does not match the reels", () => {
    expect(() => boardFrom([REEL, REEL], rect(2, 2), [0])).toThrow(/1 stops for 2 reels/);
  });
});

describe("reading a strip's probabilities", () => {
  test("per-cell chance is the count over the length", () => {
    expect(countOn(STACKED, "W")).toBe(3);
    expect(cellProbability(STACKED, "W")).toBeCloseTo(3 / 8, 10);
  });

  test("at-least-one in a window is NOT height times the per-cell chance", () => {
    // The naive formula says 3 * 3/8 = 1.125, which is not even a probability.
    // Counted over the stops: a 3-window touches the 3-stack from 5 of 8 stops.
    expect(windowProbability(STACKED, "W", 3)).toBeCloseTo(5 / 8, 10);
    expect(3 * cellProbability(STACKED, "W")).toBeGreaterThan(1);
  });

  test("expected COUNT is height times the per-cell chance, and that one is exact", () => {
    expect(expectedInWindow(STACKED, "W", 3)).toBeCloseTo(9 / 8, 10);
    // and it matches the distribution's mean
    const dist = windowCountDistribution(STACKED, "W", 3);
    const mean = dist.reduce((acc, p, n) => acc + p * n, 0);
    expect(mean).toBeCloseTo(9 / 8, 10);
  });

  test("the distribution sums to one and covers every possible count", () => {
    const dist = windowCountDistribution(STACKED, "W", 3);
    expect(dist).toHaveLength(4);                      // 0..3
    expect(dist.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(dist[3]).toBeCloseTo(1 / 8, 10);            // the one stop showing the whole stack
  });

  test("the longest run decides how tall a stack can be, counting the wrap", () => {
    expect(longestRun(STACKED, "W")).toBe(3);
    expect(longestRun(["W", "L", "L", "W"], "W")).toBe(2);   // wraps around the end
    expect(longestRun(["W", "W"], "W")).toBe(2);             // an all-W reel stops at its length
  });

  test("a simulation agrees with the exact figures", () => {
    const rng = mulberry32(5);
    const trials = 40_000;
    let windows = 0;
    let total = 0;
    for (let i = 0; i < trials; i++) {
      const w = windowAt(STACKED, drawStops([STACKED], rng)[0]!, 3);
      const n = w.filter((s) => s === "W").length;
      if (n > 0) windows++;
      total += n;
    }
    expect(windows / trials).toBeCloseTo(windowProbability(STACKED, "W", 3), 1);
    expect(total / trials).toBeCloseTo(expectedInWindow(STACKED, "W", 3), 1);
  });
});

describe("building a strip from a listing", () => {
  test("contains exactly what was asked for", () => {
    const strip = stripOf({ LOW: 5, HIGH: 2 }, mulberry32(1));
    expect(strip).toHaveLength(7);
    expect(countOn(strip, "LOW")).toBe(5);
    expect(countOn(strip, "HIGH")).toBe(2);
  });

  test("the order comes from the stream, so it replays", () => {
    expect(stripOf({ A: 3, B: 3 }, mulberry32(9))).toEqual(stripOf({ A: 3, B: 3 }, mulberry32(9)));
  });

  test("refuses a listing that cannot be a reel", () => {
    expect(() => stripOf({ A: -1 }, mulberry32(1))).toThrow(/non-negative whole number/);
    expect(() => stripOf({ A: 0 }, mulberry32(1))).toThrow(/at least one symbol/);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
