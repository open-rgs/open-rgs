// A meter's bugs are all about WHEN: awarding twice, awarding once for a spin
// that crossed two thresholds, losing the remainder when it fills.

import { describe, expect, test } from "bun:test";
import {
  METER_CARRY_VERSION, collect, fillLevel, fromCarry, isAtMax, isFull, meter, progress,
  reset, spend, spinsToFill, toCarry, toNext, type MeterConfig,
} from "../src/index.js";

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

describe("bounds", () => {
  const CAPPED: MeterConfig<string> = { thresholds: [{ at: 2, award: "X" }], max: 5 };

  test("collecting past the ceiling clamps rather than throwing", () => {
    // A spin that collects more than the meter can hold is a good spin.
    const out = collect(meter<string>(CAPPED), 99, CAPPED);
    expect(out.meter.count).toBe(5);
    expect(out.awards).toEqual(["X"]);
    expect(isAtMax(out.meter, CAPPED)).toBe(true);
  });

  test("a meter with a floor starts at it", () => {
    const MULT: MeterConfig<string> = { thresholds: [{ at: 5, award: "X" }], min: 1, max: 10 };
    expect(meter(MULT).count).toBe(1);
    expect(fillLevel(meter(MULT), MULT)).toBe(0);
  });

  test("fill level runs between the floor and the ceiling", () => {
    const MULT: MeterConfig<string> = { thresholds: [], min: 1, max: 11 };
    const m = collect(meter<string>(MULT), 4, MULT).meter;   // 1 -> 5
    expect(fillLevel(m, MULT)).toBeCloseTo(0.4, 10);
  });

  test("an unbounded meter has no fill level, which is different from being empty", () => {
    expect(fillLevel(meter<string>(), { thresholds: [] })).toBe(0);
    expect(isAtMax(meter<string>(), { thresholds: [] })).toBe(false);
  });
});

describe("spending a meter down", () => {
  const CFG2: MeterConfig<string> = { thresholds: [{ at: 3, award: "MINI" }], min: 0, max: 10 };

  test("takes from the count and stops at the floor", () => {
    const m = collect(meter<string>(CFG2), 5, CFG2).meter;
    expect(spend(m, 2, CFG2).count).toBe(3);
    expect(spend(m, 99, CFG2).count).toBe(0);
    expect(spend(m, 0, CFG2)).toBe(m);
    expect(() => spend(m, -1, CFG2)).toThrow(/non-negative/);
  });

  test("a rung already earned stays earned, so refilling does not pay twice", () => {
    let m = collect(meter<string>(CFG2), 3, CFG2).meter;      // MINI awarded
    m = spend(m, 3, CFG2);                                     // back to zero
    expect(collect(m, 3, CFG2).awards).toEqual([]);            // and no second MINI
  });

  test("unless the game says otherwise", () => {
    const REARM: MeterConfig<string> = { ...CFG2, reawardAfterSpend: true };
    let m = collect(meter<string>(REARM), 3, REARM).meter;
    m = spend(m, 3, REARM);
    expect(collect(m, 3, REARM).awards).toEqual(["MINI"]);
  });
});

describe("carry", () => {
  const CFG3: MeterConfig<string> = { thresholds: [{ at: 3, award: "MINI" }, { at: 6, award: "MINOR" }], max: 20 };

  test("a meter survives a round trip through carry", () => {
    const m = collect(meter<string>(CFG3), 7, CFG3).meter;
    const back = fromCarry(toCarry(m), CFG3);
    expect(back).toEqual(m);
  });

  test("no carry is the first spin of a session", () => {
    expect(fromCarry(undefined, CFG3)).toEqual(meter(CFG3));
    expect(fromCarry("", CFG3)).toEqual(meter(CFG3));
  });

  test("carry this version cannot read resets by default", () => {
    expect(fromCarry('{"v":0,"count":9}', CFG3)).toEqual(meter(CFG3));
    expect(fromCarry("not json at all", CFG3)).toEqual(meter(CFG3));
    expect(fromCarry('{"v":1}', CFG3)).toEqual(meter(CFG3));      // right version, wrong shape
  });

  test("'keep-count' keeps progress and lets the rungs pay again, which is the trade", () => {
    const back = fromCarry('{"v":0,"c":7}', CFG3, "keep-count");
    expect(back.count).toBe(7);
    expect(back.awarded).toEqual([]);
    // the thresholds it already passed will pay a second time on the next collect
    expect(collect(back, 0.0001, CFG3).awards).toEqual(["MINI", "MINOR"]);
  });

  test("a function migration can preserve both progress and awards", () => {
    const old = '{"version":0,"total":7,"paid":[3]}';
    const back = fromCarry(old, CFG3, (raw) => {
      const r = raw as { total?: number; paid?: number[] };
      return { count: r.total ?? 0, awarded: r.paid ?? [], laps: 0 };
    });
    expect(back).toEqual({ count: 7, awarded: [3], laps: 0 });
    expect(collect(back, 0.0001, CFG3).awards).toEqual(["MINOR"]);   // MINI stays paid
  });

  test("a count outside the bounds is clamped on the way back in", () => {
    // The ceiling may have been lowered since this carry was written.
    expect(fromCarry('{"v":1,"c":500,"a":[],"l":0}', CFG3).count).toBe(20);
  });

  test("the serialised form is small, since it rides every settle", () => {
    const m = collect(meter<string>(CFG3), 7, CFG3).meter;
    expect(toCarry(m).length).toBeLessThan(60);
    expect(JSON.parse(toCarry(m)).v).toBe(METER_CARRY_VERSION);
  });
});
