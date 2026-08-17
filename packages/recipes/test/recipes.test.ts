// The claim: every board comes from exactly one declared recipe, at exactly
// the declared rate. If that holds, `RTP = sum p_i * RTP_i` is arithmetic and a
// tease is a measurable, defensible number. If it does not hold, the whole
// pricing argument collapses - so the rates are MEASURED here, not asserted
// from the construction.

import { describe, expect, test } from "bun:test";
import { at, countOf, fromColumns, makeGrid, rect } from "@open-rgs/grid";
import { cols, holding, randomN } from "@open-rgs/selectors";
import { sampler } from "@open-rgs/weights";
import { expectedRate, fixed, place, placeAt, placeDrawn, recipes, stack } from "../src/index.js";

const SHAPE = rect(5, 3);
const blank = () => makeGrid(SHAPE, () => "LOW");
/** A real PRNG, NOT a uniform ramp.
 *
 *  A ramp is only valid when every iteration consumes a FIXED number of draws.
 *  A mixture breaks that by construction: selecting a recipe costs one float,
 *  and then each recipe consumes a different amount (a plain board draws
 *  nothing extra, a two-symbol placement draws two more). The ramp's phase
 *  therefore drifts against the selection, and measured recipe rates come out
 *  wrong by a factor - here 0.05 read as 0.0167. Determinism comes from a fixed
 *  seed instead. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sweep = (seed: number) => mulberry32(seed);

describe("mixture validation", () => {
  test("probabilities must sum to 1", () => {
    // 0.98 silently drops 2% of spins onto whichever recipe rounding lands on,
    // and the RTP computed from the declared weights is wrong by an amount
    // nobody will notice.
    expect(() => recipes([{ name: "a", p: 0.5, draw: blank }, { name: "b", p: 0.48, draw: blank }]))
      .toThrow(/must sum to 1/);
    expect(() => recipes([{ name: "a", p: 0.6, draw: blank }, { name: "b", p: 0.6, draw: blank }]))
      .toThrow(/must sum to 1/);
    expect(() => recipes([{ name: "a", p: 1, draw: blank }])).not.toThrow();
  });

  test("names must be unique - they are the reporting key", () => {
    expect(() => recipes([{ name: "x", p: 0.5, draw: blank }, { name: "x", p: 0.5, draw: blank }]))
      .toThrow(/duplicate recipe name/);
  });

  test("rejects an invalid probability", () => {
    expect(() => recipes([{ name: "a", p: -1, draw: blank }, { name: "b", p: 2, draw: blank }]))
      .toThrow(/invalid probability/);
    expect(() => recipes([{ name: "a", p: NaN, draw: blank }])).toThrow(/invalid probability/);
  });

  test("needs at least one recipe", () => {
    expect(() => recipes([])).toThrow(/at least one/);
  });

  test("tolerates float drift in hand-written weights", () => {
    expect(() => recipes([
      { name: "a", p: 0.1, draw: blank }, { name: "b", p: 0.2, draw: blank },
      { name: "c", p: 0.3, draw: blank }, { name: "d", p: 0.4, draw: blank },
    ])).not.toThrow();
  });
});

describe("selection", () => {
  const m = recipes([
    { name: "base", p: 0.90, draw: blank },
    { name: "tease", p: 0.09, draw: placeAt("SC", cols([0, 1]), blank) },
    { name: "jackpot", p: 0.01, draw: stack("WILD", 2, blank) },
  ]);

  test("reports which recipe produced the board", () => {
    const names = new Set<string>();
    const next = sweep(1000);
    for (let i = 0; i < 1000; i++) names.add(m(next).recipe);
    expect(names).toEqual(new Set(["base", "tease", "jackpot"]));
  });

  test("measured rate matches the declared probability", () => {
    const counts: Record<string, number> = {};
    const N = 200_000;
    const next = sweep(N);
    for (let i = 0; i < N; i++) {
      const d = m(next);
      counts[d.recipe] = (counts[d.recipe] ?? 0) + 1;
    }
    expect(counts["base"]! / N).toBeCloseTo(0.90, 2);
    expect(counts["tease"]! / N).toBeCloseTo(0.09, 2);
    expect(counts["jackpot"]! / N).toBeCloseTo(0.01, 2);
  });

  test("probabilityOf is the analytic weight for RTP accounting", () => {
    expect(m.probabilityOf("tease")).toBe(0.09);
    expect(m.probabilityOf("nope")).toBe(0);
    expect(expectedRate(m, "jackpot", 1_000_000)).toBe(10_000);
  });

  test("a zero-probability recipe is unreachable at every r", () => {
    // Including the top of the range, where the cumulative table goes flat.
    const z = recipes([
      { name: "live", p: 1, draw: blank },
      { name: "dead", p: 0, draw: fixed(makeGrid(SHAPE, () => "DEAD")) },
    ]);
    for (const r of [0, 0.5, 0.999999, 1, 2]) expect(z(() => r).recipe).toBe("live");
  });

  test("the chosen recipe's own draw is what runs", () => {
    const only = recipes([{ name: "stacked", p: 1, draw: stack("WILD", 2, blank) }]);
    const g = only(sweep(7)).grid;
    for (let row = 0; row < 3; row++) expect(at(g, 2, row)).toBe("WILD");
    expect(at(g, 0, 0)).toBe("LOW");
  });
});

describe("placement building blocks", () => {
  test("placeAt writes into every selected cell", () => {
    const g = placeAt("SC", cols([0]), blank)(sweep(11));
    expect(countOf(g, "SC")).toBe(3);
    expect(at(g, 0, 2)).toBe("SC");
    expect(at(g, 1, 0)).toBe("LOW");
  });

  test("place puts exactly n, and refuses to under-deliver", () => {
    const g = place(2, "SC", randomN(2, cols([0, 1])), blank)(sweep(13));
    expect(countOf(g, "SC")).toBe(2);
    // A recipe named "3 high symbols" that quietly places 2 is mispriced
    // against its own name.
    expect(() => place(9, "SC", randomN(9, cols([0])), blank)(sweep(13))).toThrow(/only 3/);
  });

  test("stack fills a whole column, ragged included", () => {
    const ragged = () => makeGrid([2, 4, 2], () => "LOW");
    const g = stack("WILD", 1, ragged)(sweep(5));
    expect(countOf(g, "WILD")).toBe(4);
    expect(at(g, 0, 0)).toBe("LOW");
  });

  test("stack on a column that does not exist is a no-op, not a crash", () => {
    const g = stack("WILD", 99, blank)(sweep(5));
    expect(countOf(g, "WILD")).toBe(0);
  });

  test("placeDrawn chooses the symbol as well as the cell", () => {
    // "place 3 HIGH symbols" where HIGH is itself a weighted choice.
    const highs = sampler({ H1: 1, H2: 1, H3: 1 });
    const g = placeDrawn(3, highs, randomN(3), blank)(sweep(101));
    const placed = ["H1", "H2", "H3"].reduce((n, s) => n + countOf(g, s), 0);
    expect(placed).toBe(3);
  });

  test("placements compose - a recipe is a pipeline", () => {
    const g = place(1, "SC", randomN(1, cols([4])), stack("WILD", 0, blank))(sweep(23));
    expect(countOf(g, "WILD")).toBe(3);
    expect(countOf(g, "SC")).toBe(1);
  });

  test("fixed returns the same board and draws nothing", () => {
    const pinned = fromColumns([["A"], ["B"]]);
    const g = fixed(pinned)(() => { throw new Error("should not draw"); });
    expect(g).toBe(pinned);
  });
});

describe("the tease is measurable - the whole point", () => {
  test("near-miss rate is a number you can compute and defend", () => {
    // Two scatters and no third. Under the base recipe alone this never
    // happens; the tease recipe produces it at its declared rate, so the
    // "extra" tease frequency is exactly the recipe's probability - reportable
    // rather than emergent.
    const m = recipes([
      { name: "base", p: 0.95, draw: blank },
      { name: "two-scatter", p: 0.05, draw: place(2, "SC", randomN(2, cols([0, 1])), blank) },
    ]);

    const N = 100_000;
    const next = sweep(N);
    let twoScatters = 0;
    for (let i = 0; i < N; i++) {
      if (countOf(m(next).grid, "SC") === 2) twoScatters++;
    }
    expect(twoScatters / N).toBeCloseTo(0.05, 2);
    expect(twoScatters / N).toBeCloseTo(m.probabilityOf("two-scatter"), 2);
  });
});
