// A gamble is priced by its edge, not by its payout. These tests pin the edge
// arithmetic, and the two limits that keep a round finite.

import { describe, expect, test } from "bun:test";
import {
  collectOrRisk, fairChance, gambleLadder, gambleOnce, ladderReturn, stepEdge,
  stepReturn, survivalChance, type GambleStep,
} from "../src/index.js";

const FAIR: GambleStep = { chance: 0.5, on: 2 };
const EDGED: GambleStep = { chance: 0.49, on: 2 };
const HALF: GambleStep = { chance: 0.5, on: 1.5, onLoss: 0.5 };

describe("what a step is worth", () => {
  test("double-or-nothing at exactly half is fair, and adds RTP to a game that offers it", () => {
    expect(stepReturn(FAIR)).toBe(1);
    expect(stepEdge(FAIR)).toBe(0);
  });

  test("a percent off the chance is a percent of edge", () => {
    expect(stepReturn(EDGED)).toBeCloseTo(0.98, 10);
    expect(stepEdge(EDGED)).toBeCloseTo(0.02, 10);
  });

  test("a half gamble keeps some of the stake, so it needs a different chance to be fair", () => {
    expect(stepReturn(HALF)).toBe(1);
    expect(fairChance(1.5, 0.5)).toBe(0.5);
    expect(fairChance(2)).toBe(0.5);
    expect(fairChance(4)).toBe(0.25);
  });

  test("a step that pays the player to take it is a mistake worth seeing", () => {
    expect(stepEdge({ chance: 0.6, on: 2 })).toBeCloseTo(-0.2, 10);
  });

  test("nonsense is refused rather than silently priced", () => {
    expect(() => stepReturn({ chance: 1.4, on: 2 })).toThrow(/probability/);
    expect(() => stepReturn({ chance: 0.5, on: -1 })).toThrow(/non-negative/);
    expect(() => fairChance(1, 1)).toThrow(/must exceed/);
  });
});

describe("one step", () => {
  test("wins below the chance, loses above it", () => {
    expect(gambleOnce(10, FAIR, () => 0.2)).toEqual({ won: true, stake: 20 });
    expect(gambleOnce(10, FAIR, () => 0.8)).toEqual({ won: false, stake: 0 });
  });

  test("a half gamble leaves half behind", () => {
    expect(gambleOnce(10, HALF, () => 0.9)).toEqual({ won: false, stake: 5 });
  });
});

describe("a ladder", () => {
  const always = () => true;

  test("climbs while the policy says to and stops at maxSteps", () => {
    const r = gambleLadder(1, FAIR, always, () => 0, { maxSteps: 4 });
    expect(r.steps).toBe(4);
    expect(r.stake).toBe(16);
    expect(r.busted).toBe(false);
    expect(r.cappedOut).toBe(true);
    expect(r.history).toEqual([2, 4, 8, 16]);
  });

  test("a lost step ends the round at nothing", () => {
    let n = 0;
    const r = gambleLadder(1, FAIR, always, () => (++n === 3 ? 0.9 : 0), { maxSteps: 5 });
    expect(r.busted).toBe(true);
    expect(r.stake).toBe(0);
    expect(r.steps).toBe(3);
  });

  test("a stake cap ends the round at the cap", () => {
    const r = gambleLadder(1, FAIR, always, () => 0, { maxSteps: 10, maxStake: 5 });
    expect(r.stake).toBe(5);
    expect(r.cappedOut).toBe(true);
  });

  test("a policy that declines immediately keeps the win", () => {
    const r = gambleLadder(7, FAIR, () => false, () => 0, { maxSteps: 5 });
    expect(r).toMatchObject({ stake: 7, steps: 0, busted: false });
  });

  test("a fair ladder does not move RTP however far it climbs", () => {
    expect(ladderReturn(FAIR, 0)).toBe(1);
    expect(ladderReturn(FAIR, 5)).toBe(1);
    // an edged one decays geometrically
    expect(ladderReturn(EDGED, 5)).toBeCloseTo(0.98 ** 5, 10);
  });

  test("surviving five fair steps is one in thirty-two", () => {
    expect(survivalChance(FAIR, 5)).toBeCloseTo(1 / 32, 10);
  });

  test("the closed form matches a simulation of a player who always climbs", () => {
    const rng = mulberry32(3);
    const trials = 40_000;
    let total = 0;
    for (let i = 0; i < trials; i++) {
      total += gambleLadder(1, EDGED, always, rng, { maxSteps: 3 }).stake;
    }
    // A player who always climbs keeps, per unit staked, exactly the ladder's
    // return: (chance * on)^steps, which is what ladderReturn computes.
    expect(ladderReturn(EDGED, 3)).toBeCloseTo((EDGED.chance * EDGED.on) ** 3, 12);
    expect(total / trials).toBeCloseTo(ladderReturn(EDGED, 3), 1);
  });
});

describe("collect or risk", () => {
  test("the prize grows while the player declines to collect", () => {
    const r = collectOrRisk(1, 1, 0.8, () => true, () => 0.1, { maxSteps: 3 });
    expect(r.stake).toBe(4);
    expect(r.history).toEqual([2, 3, 4]);
  });

  test("a failed step loses everything", () => {
    let n = 0;
    const r = collectOrRisk(5, 5, 0.8, () => true, () => (++n === 2 ? 0.99 : 0.1), { maxSteps: 4 });
    expect(r.busted).toBe(true);
    expect(r.stake).toBe(0);
  });

  test("a cap ends the round", () => {
    const r = collectOrRisk(1, 5, 1, () => true, () => 0, { maxSteps: 10, maxStake: 9 });
    expect(r.stake).toBe(9);
    expect(r.cappedOut).toBe(true);
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
