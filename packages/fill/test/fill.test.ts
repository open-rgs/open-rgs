// The claim this package makes is that the number you declare is the number
// you get. So the load-bearing tests measure empirical frequency against the
// declared probability, and check that the analytic helpers agree with a
// simulation rather than merely with themselves.

import { describe, expect, test } from "bun:test";
import { at, countOf, rect, sizeOf, widthOf } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import {
  cellProbability, constant, expectedCount, fill, fillPerColumn,
  fillWeights, fillWeightsPerColumn,
} from "../src/index.js";

/** Uniform sweep of [0,1): makes empirical frequency converge exactly, so a
 *  failure means the mapping is wrong rather than that sampling was unlucky. */
const sweep = (n: number) => { let i = 0; return () => (i++ % n) / n; };

const SHAPE = rect(5, 3);
const RAGGED = [4, 5, 5, 5, 5, 4] as const;

describe("fill", () => {
  test("produces the requested shape", () => {
    const g = fill(SHAPE, sampler({ A: 1 }))(() => 0.5);
    expect(g.shape).toBe(SHAPE);
    expect(g.cells).toHaveLength(15);
  });

  test("works on a ragged shape without special-casing", () => {
    const g = fill(RAGGED, sampler({ A: 1 }))(() => 0.5);
    expect(g.cells).toHaveLength(sizeOf(RAGGED));
    expect(at(g, 0, 4)).toBeUndefined();
    expect(at(g, 1, 4)).toBe("A");
  });

  test("consumes exactly one draw per cell", () => {
    let calls = 0;
    fill(RAGGED, sampler({ A: 1 }))(() => { calls++; return 0.5; });
    expect(calls).toBe(sizeOf(RAGGED));
  });

  test("declared probability is the observed frequency", () => {
    const set = sampler({ LOW: 70, HIGH: 25, WILD: 5 });
    const gen = fill(SHAPE, set);
    const N = 20_000;
    const next = sweep(1000);
    const counts: Record<string, number> = { LOW: 0, HIGH: 0, WILD: 0 };
    let cells = 0;
    for (let i = 0; i < N; i++) {
      const g = gen(next);
      for (const s of g.cells) { counts[s] = (counts[s] ?? 0) + 1; cells++; }
    }
    expect(counts["LOW"]! / cells).toBeCloseTo(0.70, 2);
    expect(counts["HIGH"]! / cells).toBeCloseTo(0.25, 2);
    expect(counts["WILD"]! / cells).toBeCloseTo(0.05, 2);
  });

  test("a zero-weight symbol never appears on the grid", () => {
    const gen = fill(SHAPE, sampler({ A: 1, B: 1, SCATTER: 0 }));
    const next = sweep(997);
    for (let i = 0; i < 2000; i++) expect(countOf(gen(next), "SCATTER")).toBe(0);
  });

  test("rejects a bad shape at build time", () => {
    expect(() => fill([], sampler({ A: 1 }))).toThrow(/at least one column/);
    expect(() => fill([3, 0], sampler({ A: 1 }))).toThrow(/positive integer/);
  });
});

describe("fillPerColumn", () => {
  const sets = [
    sampler({ LOW: 1, WILD: 0 }),  // no wild on reel 0
    sampler({ LOW: 1, WILD: 1 }),
    sampler({ LOW: 1, WILD: 1 }),
    sampler({ LOW: 1, WILD: 1 }),
    sampler({ LOW: 1, WILD: 0 }),  // nor on reel 4
  ];

  test("each column draws from its own set", () => {
    const gen = fillPerColumn(SHAPE, sets);
    const next = sweep(499);
    for (let i = 0; i < 2000; i++) {
      const g = gen(next);
      for (let r = 0; r < 3; r++) {
        expect(at(g, 0, r)).toBe("LOW");
        expect(at(g, 4, r)).toBe("LOW");
      }
    }
  });

  test("wilds do land on the middle reels", () => {
    const gen = fillPerColumn(SHAPE, sets);
    const next = sweep(499);
    let wilds = 0;
    for (let i = 0; i < 500; i++) wilds += countOf(gen(next), "WILD");
    expect(wilds).toBeGreaterThan(0);
  });

  test("a set count that does not match the shape is an authoring error", () => {
    // Otherwise it surfaces as an undefined symbol mid-spin.
    expect(() => fillPerColumn(SHAPE, sets.slice(0, 3))).toThrow(/5 columns but 3/);
    expect(() => fillPerColumn(RAGGED, sets)).toThrow(/6 columns but 5/);
  });
});

describe("analytic helpers agree with simulation", () => {
  const sets = [
    sampler({ LOW: 90, SC: 10 }),
    sampler({ LOW: 80, SC: 20 }),
    sampler({ LOW: 95, SC: 5 }),
    sampler({ LOW: 100, SC: 0 }),
    sampler({ LOW: 50, SC: 50 }),
  ];

  test("cellProbability reads the per-column odds", () => {
    expect(cellProbability(sets, 1, "SC")).toBeCloseTo(0.2, 12);
    expect(cellProbability(sets, 3, "SC")).toBe(0);
    expect(cellProbability(sets, 99, "SC")).toBe(0); // off-grid column
  });

  test("expectedCount matches a measured mean", () => {
    // The point of the package: "how many scatters per spin" is arithmetic,
    // not a simulation. This asserts the arithmetic is right by simulating it.
    const analytic = expectedCount(SHAPE, sets, "SC");
    expect(analytic).toBeCloseTo(3 * (0.1 + 0.2 + 0.05 + 0 + 0.5), 12);

    const gen = fillPerColumn(SHAPE, sets);
    const next = sweep(1009);
    const N = 20_000;
    let total = 0;
    for (let i = 0; i < N; i++) total += countOf(gen(next), "SC");
    expect(total / N).toBeCloseTo(analytic, 1);
  });

  test("expectedCount respects ragged column heights", () => {
    const rSets = Array.from({ length: widthOf(RAGGED) }, () => sampler({ A: 1, B: 1 }));
    // Half of 28 cells, not half of 6*5.
    expect(expectedCount(RAGGED, rSets, "A")).toBeCloseTo(sizeOf(RAGGED) / 2, 12);
  });
});

describe("convenience forms", () => {
  test("fillWeights takes a raw spec", () => {
    const g = fillWeights(SHAPE, { A: 1 })(() => 0.5);
    expect(countOf(g, "A")).toBe(15);
  });

  test("fillWeightsPerColumn takes raw specs", () => {
    const gen = fillWeightsPerColumn(SHAPE, [{ A: 1 }, { B: 1 }, { C: 1 }, { D: 1 }, { E: 1 }]);
    const g = gen(() => 0.5);
    expect(at(g, 0, 0)).toBe("A");
    expect(at(g, 4, 2)).toBe("E");
  });

  test("constant fills one symbol and consumes no randomness", () => {
    const g = constant(RAGGED, "X")(() => { throw new Error("should not draw"); });
    expect(countOf(g, "X")).toBe(sizeOf(RAGGED));
  });
});
