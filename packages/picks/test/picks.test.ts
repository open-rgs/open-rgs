// A pick round is priced by what it removes. These tests pin the two things
// that get it wrong in practice: revealing with replacement, and a stop symbol
// that is not counted as revealed.

import { describe, expect, test } from "bun:test";
import {
  expectedPickTotal, expectedPicksBeforeStop, pickN, pool, pooledFrom,
  remainingCount, reveal, revealUntil, wheel, wheelValue,
} from "../src/index.js";

/** Deterministic stream, so a reveal order is a fact rather than a hope. */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

/** mulberry32: a decent PRNG for the statistical checks below. An LCG's low
 *  bits are correlated enough to bias `Math.floor(r * n)` and make an exact
 *  expectation look wrong when it is not. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a pool reveals without replacement", () => {
  test("what came out does not come out again", () => {
    let p = pool(["a", "b", "c"]);
    const seen: string[] = [];
    const next = seq([0, 0, 0]);
    for (let i = 0; i < 3; i++) {
      const step = reveal(p, next);
      p = step.pool;
      seen.push(step.item!);
    }
    expect(seen.sort()).toEqual(["a", "b", "c"]);
    expect(remainingCount(p)).toBe(0);
    expect(reveal(p, next).item).toBeUndefined();
  });

  test("the revealed list is the order the player saw", () => {
    const p = pool([1, 2, 3, 4]);
    const out = pickN(p, 2, seq([0.99, 0]));
    expect(out.picked).toEqual([4, 1]);
    expect(out.pool.revealed).toEqual([4, 1]);
    expect(remainingCount(out.pool)).toBe(2);
  });

  test("asking for more picks than the board holds reveals what is there", () => {
    const out = pickN(pool(["x", "y"]), 5, seq([0]));
    expect(out.picked).toHaveLength(2);
    expect(remainingCount(out.pool)).toBe(0);
  });

  test("a pool built from weights draws its board once", () => {
    const p = pooledFrom({ LOW: 1 }, 6, seq([0.5]));
    expect(p.remaining).toEqual(["LOW", "LOW", "LOW", "LOW", "LOW", "LOW"]);
    expect(() => pooledFrom({ LOW: 1 }, 0, seq([0.5]))).toThrow(/positive integer/);
  });
});

describe("keep picking until a stop", () => {
  const isBomb = (s: string) => s === "BOMB";

  test("the stop is included, because the player saw it", () => {
    const p = pool(["1", "2", "BOMB", "5"]);
    const out = revealUntil(p, isBomb, seq([0, 0, 0, 0]));
    expect(out.picked).toEqual(["1", "2", "BOMB"]);
    expect(out.stoppedBy).toBe("BOMB");
    expect(out.exhausted).toBe(false);
  });

  test("a board with no stop reports that it ran out", () => {
    const out = revealUntil(pool(["1", "2"]), isBomb, seq([0]));
    expect(out.stoppedBy).toBeUndefined();
    expect(out.exhausted).toBe(true);
    expect(out.picked).toHaveLength(2);
  });

  test("maxPicks bounds a round that would otherwise clear the board", () => {
    const out = revealUntil(pool(["1", "2", "3", "4"]), isBomb, seq([0]), { maxPicks: 2 });
    expect(out.picked).toHaveLength(2);
    expect(remainingCount(out.pool)).toBe(2);
  });

  test("the average length of a collect-until-bomb round is arithmetic, not a guess", () => {
    // 12 boxes, 3 bombs: (12-3)/(3+1) = 2.25 prizes before the bomb.
    expect(expectedPicksBeforeStop(12, 3)).toBeCloseTo(2.25, 10);
    expect(expectedPicksBeforeStop(12, 0)).toBe(12);   // no bomb: the whole board
    expect(expectedPicksBeforeStop(4, 4)).toBe(0);     // all bombs: nothing first

    // and it matches what actually happens
    const trials = 20_000;
    let total = 0;
    const rng = mulberry32(1);
    for (let i = 0; i < trials; i++) {
      const board = ["BOMB", "BOMB", "BOMB", ...Array.from({ length: 9 }, (_, k) => String(k))];
      const out = revealUntil(pool(board), isBomb, rng);
      total += out.picked.length - (out.stoppedBy ? 1 : 0);
    }
    expect(total / trials).toBeCloseTo(2.25, 1);
  });
});

describe("pricing a pick round", () => {
  test("expected total is the pool's mean times the number of picks", () => {
    const p = pool([1, 2, 3, 9]);        // mean 3.75
    expect(expectedPickTotal(p, 2, (n) => n)).toBeCloseTo(7.5, 10);
    expect(expectedPickTotal(p, 99, (n) => n)).toBeCloseTo(15, 10);   // capped at the board
    expect(expectedPickTotal(pool([]), 3, (n) => n as number)).toBe(0);
  });

  test("the closed form matches a simulation", () => {
    const values = [0, 1, 2, 5, 10, 25];
    const rng = mulberry32(7);
    let total = 0;
    const trials = 20_000;
    for (let i = 0; i < trials; i++) {
      total += pickN(pool(values), 3, rng).picked.reduce((a, b) => a + b, 0);
    }
    expect(total / trials).toBeCloseTo(expectedPickTotal(pool(values), 3, (n) => n), 0);
  });
});

describe("wheel", () => {
  const w = wheel({ MINI: 50, MINOR: 30, MAJOR: 15, GRAND: 5 });

  test("segments are typed, so a typo is a type error not a dead segment", () => {
    // @ts-expect-error "MEGA" is not a segment of this wheel
    expect(() => w.probabilityOf("MEGA")).not.toThrow();
    expect(w.probabilityOf("MINI")).toBeGreaterThan(0);
  });

  test("a segment's chance is the weight you wrote", () => {
    expect(w.probabilityOf("MINI")).toBeCloseTo(0.5, 10);
    expect(w.probabilityOf("GRAND")).toBeCloseTo(0.05, 10);
    expect(w.segments).toHaveLength(4);
  });

  test("a spin lands in the segment the stream points at", () => {
    expect(w.spin(() => 0)).toBe("MINI");
    expect(w.spin(() => 0.99)).toBe("GRAND");
  });

  test("handing spin a float instead of the rng says so", () => {
    // Easy to reach for, since Sampler.pick DOES take a float. The message
    // names the difference rather than failing as "next is not a function".
    expect(() => (w.spin as unknown as (r: number) => string)(0.5)).toThrow(/host\.rng_next/);
  });

  test("wheel value is the number to check a bonus against", () => {
    const pays = { MINI: 10, MINOR: 25, MAJOR: 100, GRAND: 1000 } as const;
    // .5*10 + .3*25 + .15*100 + .05*1000 = 5 + 7.5 + 15 + 50
    expect(wheelValue(w, (seg) => pays[seg])).toBeCloseTo(77.5, 10);
  });

  test("a repeated segment sums its slices", () => {
    const two = wheel([{ item: "X", weight: 1 }, { item: "X", weight: 1 }, { item: "Y", weight: 2 }]);
    expect(two.probabilityOf("X")).toBeCloseTo(0.5, 10);
  });
});
