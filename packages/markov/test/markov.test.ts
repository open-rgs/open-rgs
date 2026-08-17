// The central claim of this package is one sentence: stickiness changes how
// clumpy the reels look and does NOT change symbol frequency. If that is false
// the package has no reason to exist over a reel strip, so it is asserted
// directly - measured frequency at several stickiness values against the
// declared base - rather than inferred from the algebra.

import { describe, expect, test } from "bun:test";
import { column, countOf, rect, sizeOf } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import {
  markovFill, meanRunLength, stackyFill, stationary, sticky, transitions,
} from "../src/index.js";

const BASE = { LOW: 60, MID: 30, HIGH: 10 } as const;
const SHAPE = rect(5, 4);
const RAGGED = [4, 5, 5, 5, 5, 4] as const;

/** A real decorrelated PRNG, NOT a uniform ramp.
 *
 *  The sibling packages test with a uniform sweep of [0,1) because their draws
 *  are independent, so sweeping makes empirical frequency converge exactly. A
 *  Markov chain is SEQUENTIAL: consecutive draws feed consecutive transitions,
 *  so a monotonic ramp makes the chain take almost the same transition every
 *  step and every measurement becomes an artifact of the ramp. Determinism here
 *  comes from a fixed seed instead. */
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

/** Measured symbol frequency across many generated grids. */
function measure(gen: (next: () => number) => { cells: readonly string[] }, spins: number) {
  const next = sweep(9973); // prime, so it does not resonate with grid size
  const counts: Record<string, number> = {};
  let cells = 0;
  for (let i = 0; i < spins; i++) {
    for (const s of gen(next).cells) { counts[s] = (counts[s] ?? 0) + 1; cells++; }
  }
  const out: Record<string, number> = {};
  for (const k of Object.keys(counts)) out[k] = counts[k]! / cells;
  return out;
}

describe("sticky transitions", () => {
  test("rejects a stickiness that would freeze the chain", () => {
    // At s >= 1 the chain never leaves its first symbol: every column becomes a
    // solid block and the stationary distribution is undefined.
    expect(() => sticky(BASE, 1)).toThrow(/\[0, 1\)/);
    expect(() => sticky(BASE, 1.5)).toThrow(/\[0, 1\)/);
    expect(() => sticky(BASE, -0.1)).toThrow(/\[0, 1\)/);
    expect(() => sticky(BASE, NaN)).toThrow(/\[0, 1\)/);
  });

  test("rejects a degenerate base", () => {
    expect(() => sticky({}, 0.5)).toThrow(/at least one symbol/);
    expect(() => sticky({ A: 0 }, 0.5)).toThrow(/more than zero/);
  });

  test("stickiness 0 reproduces independent draws", () => {
    const t = sticky(BASE, 0);
    // Every row of the table is just the base distribution.
    for (const from of ["LOW", "MID", "HIGH"] as const) {
      expect(t[from].probabilityOf("LOW")).toBeCloseTo(0.6, 12);
      expect(t[from].probabilityOf("HIGH")).toBeCloseTo(0.1, 12);
    }
  });

  test("stickiness raises P(repeat) without touching the stationary marginals", () => {
    const t = sticky(BASE, 0.8);
    expect(t["HIGH"].probabilityOf("HIGH")).toBeCloseTo(0.8 + 0.2 * 0.1, 12);
    const pi = stationary(t);
    expect(pi["HIGH"]).toBeCloseTo(0.1, 9);
  });
});

describe("stationary distribution", () => {
  test("equals the base for any stickiness - the whole point", () => {
    for (const s of [0, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      const pi = stationary(sticky(BASE, s));
      expect(pi["LOW"]).toBeCloseTo(0.6, 6);
      expect(pi["MID"]).toBeCloseTo(0.3, 6);
      expect(pi["HIGH"]).toBeCloseTo(0.1, 6);
    }
  });

  test("solves a hand-written table too", () => {
    // Two-state chain: P(A->B) = 0.25, P(B->A) = 0.75. Stationary is
    // proportional to the reverse rates: A = 0.75/(0.75+0.25) = 0.75.
    const t = transitions({ A: { A: 75, B: 25 }, B: { A: 75, B: 25 } });
    const pi = stationary(t);
    expect(pi["A"]).toBeCloseTo(0.75, 9);
    expect(pi["B"]).toBeCloseTo(0.25, 9);
  });

  test("an unreachable symbol honestly gets probability 0", () => {
    const t = transitions({ A: { A: 1, GHOST: 0 }, GHOST: { A: 1, GHOST: 0 } });
    const pi = stationary(t);
    expect(pi["GHOST"]).toBeCloseTo(0, 9);
    expect(pi["A"]).toBeCloseTo(1, 9);
  });

  test("sums to 1", () => {
    const pi = stationary(sticky(BASE, 0.6));
    expect(Object.values(pi).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("frequency is invariant to stickiness - measured, not derived", () => {
  test("measured symbol frequency matches the base at every stickiness", () => {
    for (const s of [0, 0.4, 0.85]) {
      const freq = measure(stackyFill(SHAPE, BASE, s), 4000);
      expect(freq["LOW"]).toBeCloseTo(0.6, 1);
      expect(freq["MID"]).toBeCloseTo(0.3, 1);
      expect(freq["HIGH"]).toBeCloseTo(0.1, 1);
    }
  });

  test("but stacking really does increase with stickiness", () => {
    // Same frequency, different clumping. Count columns that are a solid block
    // of one symbol - rare at s=0, common at s=0.9.
    const solidRate = (s: number) => {
      const gen = stackyFill(SHAPE, BASE, s);
      const next = sweep(9973);
      let solid = 0;
      const N = 3000;
      for (let i = 0; i < N; i++) {
        const g = gen(next);
        for (let c = 0; c < 5; c++) {
          const colSyms = column(g, c);
          if (colSyms.every((x) => x === colSyms[0])) solid++;
        }
      }
      return solid / (N * 5);
    };
    const loose = solidRate(0);
    const tight = solidRate(0.9);
    expect(tight).toBeGreaterThan(loose * 3);
    expect(loose).toBeLessThan(0.3);
    expect(tight).toBeGreaterThan(0.5);
  });
});

describe("markovFill", () => {
  test("produces the requested shape, ragged included", () => {
    const g = stackyFill(RAGGED, BASE, 0.5)(sweep(97));
    expect(g.cells).toHaveLength(sizeOf(RAGGED));
    expect(column(g, 1)).toHaveLength(5);
    expect(column(g, 0)).toHaveLength(4);
  });

  test("consumes exactly one draw per cell", () => {
    let calls = 0;
    stackyFill(RAGGED, BASE, 0.5)(() => { calls++; return 0.5; });
    expect(calls).toBe(sizeOf(RAGGED));
  });

  test("columns are independent - stacking is vertical only", () => {
    // With very high stickiness each column is near-solid, but neighbouring
    // columns must still disagree often. If they matched, the chain would be
    // leaking across reels.
    const gen = stackyFill(rect(2, 4), BASE, 0.97);
    const next = sweep(9973);
    let sameNeighbour = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const g = gen(next);
      if (column(g, 0)[0] === column(g, 1)[0]) sameNeighbour++;
    }
    // Independent columns agree at sum(p^2) = .36+.09+.01 = .46
    expect(sameNeighbour / N).toBeCloseTo(0.46, 1);
  });

  test("a missing transition row fails loudly rather than producing undefined cells", () => {
    // Forced rather than seeded: row A is {A:1, B:1}, so r = 0.9 always lands
    // on B, whose row is missing. A seed might simply never reach B in three
    // rows and the test would pass without exercising anything.
    const partial = transitions({ A: { A: 1, B: 1 } } as Record<"A", Record<string, number>>);
    const gen = markovFill(rect(1, 3), sampler({ A: 1 }), partial as never);
    expect(() => gen(() => 0.9)).toThrow(/no transition row for symbol 'B'/);
  });

  test("a zero-weight symbol never lands", () => {
    const gen = stackyFill(SHAPE, { LOW: 1, HIGH: 1, SCATTER: 0 }, 0.5);
    const next = sweep(9973);
    for (let i = 0; i < 2000; i++) expect(countOf(gen(next), "SCATTER")).toBe(0);
  });
});

describe("meanRunLength", () => {
  test("matches measured run lengths", () => {
    // The number stickiness is actually tuned against, so it must be right.
    const s = 0.7;
    const predicted = meanRunLength(BASE, s, "LOW");
    const gen = stackyFill(rect(1, 200), BASE, s);
    const next = sweep(9973);
    let runs = 0;
    let cells = 0;
    for (let i = 0; i < 400; i++) {
      const colSyms = column(gen(next), 0);
      let current: string | undefined;
      for (const sym of colSyms) {
        if (sym !== "LOW") { current = undefined; continue; }
        cells++;
        if (current !== "LOW") runs++;
        current = sym;
      }
    }
    expect(cells / runs).toBeCloseTo(predicted, 0);
  });

  test("stickiness 0 gives the independent-draw run length", () => {
    // 1 / (1 - p) for p = 0.1
    expect(meanRunLength(BASE, 0, "HIGH")).toBeCloseTo(1 / 0.9, 9);
  });

  test("longer runs as stickiness rises", () => {
    const a = meanRunLength(BASE, 0.2, "HIGH");
    const b = meanRunLength(BASE, 0.9, "HIGH");
    expect(b).toBeGreaterThan(a * 3);
  });
});
