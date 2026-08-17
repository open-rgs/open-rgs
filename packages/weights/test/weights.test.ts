// Two things carry this suite: that boundaries land on the right side (an
// off-by-one in a cumulative search skews every RTP built on it, silently), and
// that the stated probability matches the empirical one - because the whole
// pitch of this package over reel strips is that the number you read is true.

import { describe, expect, test } from "bun:test";
import { normalized, pickDistinct, sampler } from "../src/index.js";

/** Largest double strictly below 1 - the true top of an rng's [0, 1) range. */
const BELOW_ONE = 1 - Number.EPSILON / 2;

describe("building", () => {
  test("accepts a plain record, which is how paytables get written", () => {
    const s = sampler({ LOW: 60, MID: 30, HIGH: 10 });
    expect(s.total).toBe(100);
    expect(s.probabilityOf("LOW")).toBeCloseTo(0.6, 12);
    expect(s.probabilityOf("HIGH")).toBeCloseTo(0.1, 12);
  });

  test("accepts explicit entries, which allow non-string items", () => {
    const s = sampler([{ item: 1, weight: 1 }, { item: 2, weight: 3 }]);
    expect(s.probabilityOf(2)).toBeCloseTo(0.75, 12);
  });

  test("rejects what would make a draw ill-defined", () => {
    expect(() => sampler([])).toThrow(/at least one entry/);
    expect(() => sampler({ A: 0 })).toThrow(/greater than zero/);
    expect(() => sampler({ A: 1, B: -1 })).toThrow(/negative weight/);
    expect(() => sampler({ A: 1, B: Infinity })).toThrow(/non-finite/);
    expect(() => sampler({ A: 1, B: NaN })).toThrow(/non-finite/);
  });

  test("a zero-weight entry is legal and reports probability 0", () => {
    // A symbol present in the game but excluded from this mode's draw.
    const s = sampler({ LOW: 50, SCATTER: 0, HIGH: 50 });
    expect(s.probabilityOf("SCATTER")).toBe(0);
    expect(s.items).toContain("SCATTER");
  });

  test("a repeated item sums its weights", () => {
    const s = sampler([{ item: "A", weight: 1 }, { item: "B", weight: 1 }, { item: "A", weight: 2 }]);
    expect(s.probabilityOf("A")).toBeCloseTo(0.75, 12);
  });

  test("distribution sums to 1", () => {
    const d = sampler({ A: 7, B: 11, C: 3 }).distribution();
    expect(d.reduce((n, x) => n + x.p, 0)).toBeCloseTo(1, 12);
    expect(normalized({ A: 1, B: 1 })).toEqual([{ item: "A", p: 0.5 }, { item: "B", p: 0.5 }]);
  });
});

describe("pick boundaries", () => {
  // Weights 20/30/50 -> cumulative 20/50/100 -> bands [0,0.2) [0.2,0.5) [0.5,1).
  const s = sampler({ A: 20, B: 30, C: 50 });

  test("each band's interior picks its own item", () => {
    expect(s.pick(0.0)).toBe("A");
    expect(s.pick(0.1)).toBe("A");
    expect(s.pick(0.3)).toBe("B");
    expect(s.pick(0.9)).toBe("C");
  });

  test("a boundary belongs to the band it OPENS, not the one it closes", () => {
    // The classic off-by-one. If 0.2 returned "A", every symbol's true
    // probability would be shifted by one band width and no test of the
    // average would notice.
    expect(s.pick(0.2)).toBe("B");
    expect(s.pick(0.5)).toBe("C");
  });

  test("the extremes of [0,1) stay in range", () => {
    expect(s.pick(0)).toBe("A");
    expect(s.pick(BELOW_ONE)).toBe("C");
  });

  test("an out-of-range r clamps rather than failing a spin", () => {
    expect(s.pick(-0.5)).toBe("A");
    expect(s.pick(1)).toBe("C");
    expect(s.pick(2)).toBe("C");
  });

  test("a zero-weight entry is never selected, at any r", () => {
    const z = sampler({ A: 1, GHOST: 0, B: 1 });
    for (let i = 0; i < 1000; i++) expect(z.pick(i / 1000)).not.toBe("GHOST");
  });

  test("a TRAILING zero-weight entry is unreachable even at the top of the range", () => {
    // The cumulative table is flat across a zero-weight tail, so a naive
    // "first bound > x" search lands on it when x reaches the total. Every r
    // means every r, including 1 and beyond.
    const tail = sampler({ A: 1, B: 1, GHOST: 0 });
    for (const r of [BELOW_ONE, 1, 2, 0.9999999999]) expect(tail.pick(r)).not.toBe("GHOST");
    const allTail = sampler({ A: 1, G1: 0, G2: 0 });
    expect(allTail.pick(1)).toBe("A");
  });

  test("single-entry sets always return that entry", () => {
    const one = sampler({ ONLY: 5 });
    expect(one.pick(0)).toBe("ONLY");
    expect(one.pick(0.999999)).toBe("ONLY");
  });
});

describe("stated probability matches empirical frequency", () => {
  test("a uniform sweep of r reproduces the declared distribution", () => {
    // Deterministic rather than random: sweeping r uniformly over [0,1) makes
    // observed frequency converge on the declared probability exactly, so this
    // asserts the mapping itself rather than a sampling artifact.
    const s = sampler({ LOW: 60, MID: 30, HIGH: 9, WILD: 1 });
    const N = 1_000_000;
    const seen: Record<string, number> = { LOW: 0, MID: 0, HIGH: 0, WILD: 0 };
    for (let i = 0; i < N; i++) {
      const item = s.pick(i / N);
      seen[item] = (seen[item] ?? 0) + 1;
    }
    for (const { item, p } of s.distribution()) {
      expect((seen[item] ?? 0) / N).toBeCloseTo(p, 5);
    }
  });
});

describe("pickDistinct", () => {
  const next = (seq: number[]) => { let i = 0; return () => seq[i++ % seq.length]!; };

  test("returns n different items", () => {
    const s = sampler({ A: 1, B: 1, C: 1, D: 1 });
    const got = pickDistinct(s, 3, next([0.1, 0.5, 0.9]));
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
  });

  test("n = 0 draws nothing and consumes no randomness", () => {
    const s = sampler({ A: 1 });
    let calls = 0;
    expect(pickDistinct(s, 0, () => { calls++; return 0.5; })).toEqual([]);
    expect(calls).toBe(0);
  });

  test("refuses to under-deliver rather than silently returning fewer", () => {
    // A placement directive has already priced 3 symbols into its RTP; handing
    // back 2 would corrupt the model quietly.
    const s = sampler({ A: 1, B: 1 });
    expect(() => pickDistinct(s, 3, () => 0.5)).toThrow(/only 2 have a non-zero weight/);
  });

  test("zero-weight entries do not count toward what is drawable", () => {
    const s = sampler({ A: 1, B: 1, GHOST: 0 });
    expect(() => pickDistinct(s, 3, () => 0.5)).toThrow(/only 2/);
    expect(pickDistinct(s, 2, next([0.1, 0.9]))).not.toContain("GHOST");
  });

  test("rejects a nonsense n", () => {
    const s = sampler({ A: 1 });
    expect(() => pickDistinct(s, -1, () => 0)).toThrow(/non-negative integer/);
    expect(() => pickDistinct(s, 1.5, () => 0)).toThrow(/non-negative integer/);
  });

  test("weight still biases which distinct items come out", () => {
    // HEAVY should lead far more often than LIGHT across many first draws.
    const s = sampler({ HEAVY: 99, LIGHT: 1 });
    let heavyFirst = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const r = i / N;
      if (pickDistinct(s, 1, () => r)[0] === "HEAVY") heavyFirst++;
    }
    expect(heavyFirst / N).toBeCloseTo(0.99, 2);
  });

  test("is deterministic for a given r sequence", () => {
    const s = sampler({ A: 3, B: 2, C: 1 });
    const seq = [0.11, 0.42, 0.87];
    expect(pickDistinct(s, 3, next(seq))).toEqual(pickDistinct(s, 3, next(seq)));
  });
});
