// A meter's bugs are all about WHEN: awarding twice, awarding once for a spin
// that crossed two thresholds, losing the remainder when it fills.

import { describe, expect, test } from "bun:test";
import { collect, isFull, meter, progress, reset, spinsToFill, toNext, type MeterConfig } from "../src/index.js";

const CFG: MeterConfig<string> = {
  thresholds: [{ at: 3, award: "MINI" }, { at: 6, award: "MINOR" }, { at: 10, award: "MAJOR" }],
};

describe("counting and crossing", () => {
  test("an award fires when its threshold is reached", () => {
    const out = collect(meter<string>(), 3, CFG);
    expect(out.awards).toEqual(["MINI"]);
    expect(out.meter.count).toBe(3);
  });

  test("a threshold never fires twice", () => {
    let m = collect(meter<string>(), 3, CFG).meter;
    const again = collect(m, 1, CFG);
    expect(again.awards).toEqual([]);
    expect(again.meter.count).toBe(4);
  });

  test("one spin that crosses two thresholds pays both, in order", () => {
    // The common bug is paying only the highest, and it is invisible until
    // someone reconciles a big spin against the paytable.
    const out = collect(meter<string>(), 7, CFG);
    expect(out.awards).toEqual(["MINI", "MINOR"]);
  });

  test("a spin that fills the whole meter pays every threshold", () => {
    const out = collect(meter<string>(), 12, CFG);
    expect(out.awards).toEqual(["MINI", "MINOR", "MAJOR"]);
    expect(isFull(out.meter, CFG)).toBe(true);
  });

  test("thresholds may be written in any order", () => {
    const jumbled: MeterConfig<string> = {
      thresholds: [{ at: 10, award: "MAJOR" }, { at: 3, award: "MINI" }, { at: 6, award: "MINOR" }],
    };
    expect(collect(meter<string>(), 7, jumbled).awards).toEqual(["MINI", "MINOR"]);
  });

  test("collecting nothing changes nothing", () => {
    const m = meter<string>();
    expect(collect(m, 0, CFG).meter).toBe(m);
    expect(() => collect(m, -1, CFG)).toThrow(/non-negative/);
  });
});

describe("a meter that can be filled more than once", () => {
  const REPEAT: MeterConfig<string> = { ...CFG, repeat: true };

  test("filling it starts a new lap and keeps the remainder", () => {
    const out = collect(meter<string>(), 13, REPEAT);
    expect(out.meter.laps).toBe(1);
    expect(out.meter.count).toBe(3);          // 13 - 10 carried over
    // The carried 3 already reaches the first threshold, so it is awarded
    // straight away rather than waiting for the next spin. Dropping it would
    // lose a prize the player collected the symbols for.
    expect(out.awards).toEqual(["MINI", "MINOR", "MAJOR", "MINI"]);
    expect(out.meter.awarded).toEqual([3]);
  });

  test("a remainder below the first threshold simply carries", () => {
    const out = collect(meter<string>(), 12, REPEAT);
    expect(out.meter.count).toBe(2);
    expect(out.awards).toEqual(["MINI", "MINOR", "MAJOR"]);
    expect(out.meter.awarded).toEqual([]);
  });

  test("a remainder that crosses again pays again", () => {
    const out = collect(meter<string>(), 23, REPEAT);
    expect(out.meter.laps).toBe(2);
    expect(out.awards.filter((a) => a === "MAJOR")).toHaveLength(2);
  });

  test("without repeat it stops at the top and keeps counting", () => {
    const out = collect(meter<string>(), 25, CFG);
    expect(out.meter.laps).toBe(0);
    expect(out.meter.count).toBe(25);
    expect(out.awards).toHaveLength(3);
  });
});

describe("what a client shows", () => {
  test("distance to the next threshold", () => {
    expect(toNext(meter<string>(), CFG)).toBe(3);
    expect(toNext(collect(meter<string>(), 4, CFG).meter, CFG)).toBe(2);
  });

  test("progress fills between the last threshold and the next", () => {
    expect(progress(meter<string>(), CFG)).toBeCloseTo(0, 10);
    expect(progress(collect(meter<string>(), 3, CFG).meter, CFG)).toBeCloseTo(0, 10);   // start of the next band
    expect(progress(collect(meter<string>(), 4, CFG).meter, CFG)).toBeCloseTo(1 / 3, 10);
    expect(progress(collect(meter<string>(), 20, CFG).meter, CFG)).toBe(1);
  });

  test("reset keeps the lap count, because a report wants it", () => {
    const filled = collect(meter<string>(), 10, CFG).meter;
    const fresh = reset(filled);
    expect(fresh.count).toBe(0);
    expect(fresh.awarded).toEqual([]);
    expect(fresh.laps).toBe(filled.laps);
  });
});

describe("pricing it", () => {
  test("spins to fill is the top threshold over what a spin collects", () => {
    expect(spinsToFill(CFG, 0.4)).toBeCloseTo(25, 10);
    expect(spinsToFill(CFG, 0)).toBe(Infinity);
    expect(spinsToFill({ thresholds: [] }, 1)).toBe(0);
  });

  test("and it matches what actually happens", () => {
    const rng = mulberry32(11);
    const perSpin = 0.4;
    let spins = 0;
    const trials = 2000;
    for (let i = 0; i < trials; i++) {
      let m = meter<string>();
      let n = 0;
      while (!isFull(m, CFG)) {
        // a spin collects one symbol with probability 0.4
        m = collect(m, rng() < perSpin ? 1 : 0, CFG).meter;
        n++;
      }
      spins += n;
    }
    expect(spins / trials).toBeCloseTo(spinsToFill(CFG, perSpin), 0);
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
