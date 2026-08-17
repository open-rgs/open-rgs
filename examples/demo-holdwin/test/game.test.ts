// Acceptance test for the library stack.
//
// Unit tests prove each package right in isolation; this proves they COMPOSE -
// that a real game built from them lands on a target RTP, triggers at the
// designed rate, and replays from a seed.
//
// The RTP assertion carries a confidence interval rather than a bare number,
// and the interval is the point.
//
// This game's per-spin standard deviation is ~12.8, which is what a 1-in-225
// feature paying hundreds of times bet does to a distribution. So:
//
//     spins        95% interval        useful for
//     400,000      +/- 3.9 points      nothing - accepts 92.5% to 100.4%
//   2,000,000      +/- 1.8 points      a smoke test
//  20,000,000      +/- 0.56 points     an actual RTP claim
//
// The first draft of this file asserted a +/-1.2 interval at 400k spins, which
// was wrong by a factor of three and would have passed while measuring nothing.
// The test below asserts that the TARGET falls inside the interval the sample
// actually supports, so the claim scales honestly with whatever N is chosen.

import { describe, expect, test } from "bun:test";
import { countWhere } from "@open-rgs/grid";
import createMath, {
  BASE_WEIGHTS, JACKPOTS, LAND_CHANCE, LINES, MAX_WIN, PAY, RESPINS,
  SHAPE, STACKINESS, TRIGGER_COINS, board,
} from "../src/math.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const host = (seed: number) => ({ rng_next: mulberry32(seed), log_debug: () => {} });

interface Stats {
  rtp: number; ci: number; hitRate: number; featureRate: number;
  featureRtp: number; maxSeen: number; capped: number;
}

function simulate(spins: number, seed = 4242): Stats {
  const m = createMath(host(seed));
  let sum = 0, sumSq = 0, hits = 0, features = 0, featureSum = 0, capped = 0, max = 0;
  for (let i = 0; i < spins; i++) {
    const o = m.play();
    sum += o.multiplier;
    sumSq += o.multiplier * o.multiplier;
    if (o.multiplier > 0) hits++;
    if (o.multiplier > max) max = o.multiplier;
    const f = o.ops.find((x) => (x as { kind: string }).kind === "feature") as { won: number } | undefined;
    if (f) { features++; featureSum += f.won; }
    if (o.ops.some((x) => (x as { kind: string }).kind === "maxWin")) capped++;
  }
  const mean = sum / spins;
  const variance = sumSq / spins - mean * mean;
  return {
    rtp: mean,
    ci: 1.96 * Math.sqrt(variance / spins),
    hitRate: hits / spins,
    featureRate: features / spins,
    featureRtp: featureSum / spins,
    maxSeen: max,
    capped,
  };
}

describe("the game is a pure function of its float stream", () => {
  test("the same seed gives the same spins", () => {
    const a = createMath(host(7));
    const b = createMath(host(7));
    for (let i = 0; i < 500; i++) expect(a.play()).toEqual(b.play());
  });

  test("a different seed gives different spins", () => {
    // Guards the whole suite against passing because the game ignores its rng.
    const a = createMath(host(7));
    const b = createMath(host(8));
    const seqA = Array.from({ length: 200 }, () => a.play().multiplier);
    const seqB = Array.from({ length: 200 }, () => b.play().multiplier);
    expect(seqA).not.toEqual(seqB);
  });

  test("it draws nothing from anywhere but the host", () => {
    // If the game reached Math.random, exhausting the injected stream would not
    // throw - it would quietly keep producing spins.
    let draws = 0;
    const m = createMath({
      rng_next: () => { if (++draws > 5_000) throw new Error("STREAM_END"); return 0.5; },
      log_debug: () => {},
    });
    expect(() => { for (;;) m.play(); }).toThrow("STREAM_END");
  });
});

describe("RTP", () => {
  // 2M spins ~ 1.4s. A real certification run wants 20M+ (see the table above);
  // this is a smoke test that would still catch a structural break.
  const SPINS = 2_000_000;
  const TARGET = 0.965;
  const s = simulate(SPINS);

  test("the target falls inside the interval this sample supports", () => {
    expect(Math.abs(s.rtp - TARGET)).toBeLessThan(s.ci);
  });

  test("the interval matches the arithmetic, so it cannot silently widen", () => {
    // 1.96 * 12.8 / sqrt(2e6) ~ 0.018. If volatility drifted upward the
    // interval would grow and the RTP test above would quietly stop testing.
    expect(s.ci).toBeGreaterThan(0.010);
    expect(s.ci).toBeLessThan(0.026);
  });

  test("base and feature both carry real weight", () => {
    // A game whose RTP is 95% base and 1% feature would hit the target while
    // feeling nothing like the design.
    expect(s.featureRtp).toBeGreaterThan(0.35);
    expect(s.featureRtp).toBeLessThan(0.65);
  });
});

describe("game feel", () => {
  const s = simulate(400_000); // these converge far faster than RTP does

  test("hit rate is in the intended band", () => {
    expect(s.hitRate).toBeGreaterThan(0.30);
    expect(s.hitRate).toBeLessThan(0.42);
  });

  test("the feature fires roughly once in 225 spins", () => {
    expect(1 / s.featureRate).toBeGreaterThan(150);
    expect(1 / s.featureRate).toBeLessThan(320);
  });

  test("no round ever exceeds the cap", () => {
    expect(s.maxSeen).toBeLessThanOrEqual(MAX_WIN);
  });
});

describe("the tease cannot secretly be a second trigger", () => {
  test("a coin-tease board never reaches the trigger count", () => {
    // The first draft placed 5 coins over a board already averaging ~0.5, so
    // teases reached six often enough to supply ~92% of ALL feature triggers -
    // the feature rate was mispriced and the tease was not a tease.
    const next = mulberry32(31337);
    let teases = 0, teasesThatTrigger = 0;
    for (let i = 0; i < 200_000; i++) {
      const d = board(next);
      if (d.recipe !== "coin-tease") continue;
      teases++;
      if (countWhere(d.grid, (s) => s === "COIN") >= TRIGGER_COINS) teasesThatTrigger++;
    }
    expect(teases).toBeGreaterThan(1000); // the recipe really is firing
    expect(teasesThatTrigger).toBe(0);
  });

  test("a tease board holds exactly one short of the trigger", () => {
    const next = mulberry32(555);
    for (let i = 0; i < 50_000; i++) {
      const d = board(next);
      if (d.recipe !== "coin-tease") continue;
      expect(countWhere(d.grid, (s) => s === "COIN")).toBe(TRIGGER_COINS - 1);
      return;
    }
    throw new Error("no coin-tease board produced in 50k draws");
  });
});

describe("configuration is coherent", () => {
  test("the declared shape matches the paylines", () => {
    expect(SHAPE).toEqual([3, 3, 3, 3, 3]);
    expect(LINES).toHaveLength(3);
    for (const line of LINES) expect(line).toHaveLength(5);
  });

  test("the jackpot ladder ascends", () => {
    expect(JACKPOTS.MINI).toBeLessThan(JACKPOTS.MINOR);
    expect(JACKPOTS.MINOR).toBeLessThan(JACKPOTS.MAJOR);
    expect(JACKPOTS.MAJOR).toBeLessThan(JACKPOTS.GRAND);
  });

  test("the full-board award is the top tier", () => {
    expect(RESPINS.fullBoardAward).toBe("GRAND");
  });

  test("COIN pays nothing on a line - it is a trigger, not a symbol", () => {
    expect(PAY.best("COIN")).toBe(0);
  });

  test("stackiness is a feel knob inside its legal range", () => {
    expect(STACKINESS).toBeGreaterThanOrEqual(0);
    expect(STACKINESS).toBeLessThan(1);
  });

  test("every base weight is non-negative and the set is non-empty", () => {
    const values = Object.values(BASE_WEIGHTS);
    expect(values.length).toBeGreaterThan(0);
    for (const w of values) expect(w).toBeGreaterThanOrEqual(0);
  });

  test("land chance is a probability", () => {
    expect(LAND_CHANCE).toBeGreaterThan(0);
    expect(LAND_CHANCE).toBeLessThan(1);
  });
});
