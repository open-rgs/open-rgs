// The claim: the declared count distribution IS the trigger rate. So the
// load-bearing test measures the spawned counts against the declaration - if
// those diverge, the entire reason to spawn rather than draw evaporates.
//
// The constraints (reel exclusions, protected symbols, one per reel) each get
// their own case, because each is a way to silently place fewer scatters than
// declared and quietly halve a feature's frequency.

import { describe, expect, test } from "bun:test";
import { at, countOf, fromColumns, makeGrid, posOf, rect } from "@open-rgs/grid";
import {
  assertFeasible, expectedCount, oneInFor, probabilityOfAtLeast, probabilityOfCount,
  spawnOn, withScatters, type SpawnConfig,
} from "../src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHAPE = rect(5, 3);
/** A board that CANNOT grow a scatter - the premise of the whole package. */
const board = (fill = "LOW") => makeGrid(SHAPE, () => fill);

const CFG: SpawnConfig = {
  symbol: "SC",
  count: { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 },
};

describe("the count distribution is the trigger rate", () => {
  test("declared probabilities are readable without a simulation", () => {
    expect(probabilityOfCount(CFG, 3)).toBeCloseTo(0.0045, 6);
    expect(probabilityOfAtLeast(CFG, 3)).toBeCloseTo(0.005, 6);
    expect(oneInFor(CFG, 3)).toBeCloseTo(200, 3);
    // (0*9000 + 1*700 + 2*250 + 3*45 + 4*5) / 10000
    expect(expectedCount(CFG)).toBeCloseTo(0.1355, 6);
  });

  test("spawned counts match the declaration", () => {
    // If this drifts, spawning has no advantage over a natural scatter.
    const gen = withScatters(() => board(), CFG);
    const next = mulberry32(4242);
    const N = 200_000;
    const seen: Record<number, number> = {};
    for (let i = 0; i < N; i++) {
      const n = countOf(gen(next), "SC");
      seen[n] = (seen[n] ?? 0) + 1;
    }
    for (const k of [0, 1, 2, 3, 4]) {
      expect((seen[k] ?? 0) / N).toBeCloseTo(probabilityOfCount(CFG, k), 2);
    }
  });

  test("a feature needing 3 really does fire about 1 in 200", () => {
    const gen = withScatters(() => board(), CFG);
    const next = mulberry32(7);
    const N = 200_000;
    let triggers = 0;
    for (let i = 0; i < N; i++) if (countOf(gen(next), "SC") >= 3) triggers++;
    expect(N / triggers).toBeGreaterThan(160);
    expect(N / triggers).toBeLessThan(260);
  });

  test("a never-triggering config reports Infinity rather than dividing by zero", () => {
    expect(oneInFor({ symbol: "SC", count: { 0: 1 } }, 1)).toBe(Infinity);
  });
});

describe("one per reel", () => {
  test("is the default, and holds", () => {
    const gen = withScatters(() => board(), { symbol: "SC", count: { 4: 1 } });
    const next = mulberry32(11);
    for (let i = 0; i < 500; i++) {
      const g = gen(next);
      const perReel = new Map<number, number>();
      g.cells.forEach((s, idx) => {
        if (s !== "SC") return;
        const c = posOf(g.shape, idx)!.col;
        perReel.set(c, (perReel.get(c) ?? 0) + 1);
      });
      for (const [, n] of perReel) expect(n).toBe(1);
      expect(countOf(g, "SC")).toBe(4);
    }
  });

  test("turning it off allows several on one reel", () => {
    const cfg: SpawnConfig = { symbol: "SC", count: { 3: 1 }, reels: [2], onePerReel: false };
    const next = mulberry32(3);
    let sawStack = false;
    for (let i = 0; i < 200; i++) {
      const g = spawnOn(board(), cfg, next).grid;
      expect(countOf(g, "SC")).toBe(3);
      const inReel2 = [0, 1, 2].filter((r) => at(g, 2, r) === "SC").length;
      if (inReel2 === 3) sawStack = true;
    }
    expect(sawStack).toBe(true);
  });
});

describe("reel exclusions", () => {
  test("scatters only land on the listed reels", () => {
    const cfg: SpawnConfig = { symbol: "SC", count: { 3: 1 }, reels: [1, 2, 3] };
    const next = mulberry32(5);
    for (let i = 0; i < 400; i++) {
      const g = spawnOn(board(), cfg, next).grid;
      for (let r = 0; r < 3; r++) {
        expect(at(g, 0, r)).not.toBe("SC");
        expect(at(g, 4, r)).not.toBe("SC");
      }
      expect(countOf(g, "SC")).toBe(3);
    }
  });

  test("every eligible reel is reachable", () => {
    const cfg: SpawnConfig = { symbol: "SC", count: { 1: 1 }, reels: [1, 2, 3] };
    const next = mulberry32(9);
    const reels = new Set<number>();
    for (let i = 0; i < 600; i++) {
      const g = spawnOn(board(), cfg, next).grid;
      const idx = g.cells.findIndex((s) => s === "SC");
      reels.add(posOf(g.shape, idx)!.col);
    }
    expect([...reels].sort()).toEqual([1, 2, 3]);
  });
});

describe("protected and replaceable symbols", () => {
  test("protects is never overwritten", () => {
    // A wild the player can see is about to pay must not be eaten.
    const g = fromColumns([
      ["WILD", "WILD", "WILD"],
      ["LOW", "LOW", "LOW"],
      ["LOW", "LOW", "LOW"],
      ["LOW", "LOW", "LOW"],
      ["WILD", "WILD", "WILD"],
    ]);
    const cfg: SpawnConfig = { symbol: "SC", count: { 3: 1 }, protects: ["WILD"] };
    const next = mulberry32(13);
    for (let i = 0; i < 300; i++) {
      const out = spawnOn(g, cfg, next).grid;
      expect(countOf(out, "WILD")).toBe(6);
      expect(countOf(out, "SC")).toBe(3);
    }
  });

  test("replaces limits which symbols may be taken", () => {
    const g = fromColumns([
      ["A", "B", "A"], ["B", "A", "B"], ["A", "B", "A"], ["B", "A", "B"], ["A", "B", "A"],
    ]);
    const cfg: SpawnConfig = { symbol: "SC", count: { 3: 1 }, replaces: ["B"] };
    const next = mulberry32(17);
    for (let i = 0; i < 300; i++) {
      const out = spawnOn(g, cfg, next).grid;
      expect(countOf(out, "A")).toBe(8); // 8 A cells, all untouched
      expect(countOf(out, "B")).toBe(4); // 7 B cells, 3 taken
      expect(countOf(out, "SC")).toBe(3);
    }
  });

  test("protects beats replaces when a symbol is in both", () => {
    const g = makeGrid(SHAPE, () => "A");
    const cfg: SpawnConfig = { symbol: "SC", count: { 1: 1 }, replaces: ["A"], protects: ["A"] };
    const r = spawnOn(g, cfg, mulberry32(1));
    expect(r.spawned).toBe(0);
    expect(r.wanted).toBe(1);
  });

  test("an existing scatter is never chosen again", () => {
    const g = fromColumns([["SC", "LOW", "LOW"], ["LOW", "LOW", "LOW"]]);
    const cfg: SpawnConfig = { symbol: "SC", count: { 2: 1 } };
    const r = spawnOn(g, cfg, mulberry32(2));
    expect(countOf(r.grid, "SC")).toBe(3); // the original plus two fresh
  });
});

describe("when the board cannot host the draw", () => {
  test("places what it can and REPORTS the shortfall", () => {
    // Throwing would crash a legitimate spin; silence would break the declared
    // trigger rate with nothing to notice. Reporting lets a simulator measure
    // how often the protects set is too wide.
    const g = fromColumns([["WILD", "WILD"], ["LOW", "LOW"], ["WILD", "WILD"]]);
    const cfg: SpawnConfig = { symbol: "SC", count: { 3: 1 }, protects: ["WILD"] };
    const r = spawnOn(g, cfg, mulberry32(3));
    expect(r.wanted).toBe(3);
    expect(r.spawned).toBe(1); // only reel 1 is legal, one per reel
    expect(countOf(r.grid, "SC")).toBe(1);
  });

  test("a fully protected board spawns nothing and stays intact", () => {
    const g = makeGrid(SHAPE, () => "WILD");
    const r = spawnOn(g, { symbol: "SC", count: { 4: 1 }, protects: ["WILD"] }, mulberry32(4));
    expect(r.spawned).toBe(0);
    expect(r.grid.cells).toEqual(g.cells);
  });
});

describe("feasibility is checked at build time where it can be", () => {
  test("rejects a draw that could never be honoured", () => {
    // Asking for 4 one-per-reel scatters across 3 eligible reels would quietly
    // place 3 and halve the declared trigger rate.
    expect(() => assertFeasible({ symbol: "SC", count: { 4: 1 }, reels: [1, 2, 3] }, 5))
      .toThrow(/only 3 reels are eligible/);
  });

  test("accepts it once onePerReel is off", () => {
    expect(() => assertFeasible({ symbol: "SC", count: { 4: 1 }, reels: [1, 2, 3], onePerReel: false }, 5))
      .not.toThrow();
  });

  test("a zero-weight count does not constrain feasibility", () => {
    expect(() => assertFeasible({ symbol: "SC", count: { 1: 1, 9: 0 }, reels: [0] }, 5)).not.toThrow();
  });

  test("rejects an empty eligible-reel set", () => {
    expect(() => assertFeasible({ symbol: "SC", count: { 1: 1 }, reels: [] }, 5)).toThrow(/no reels are eligible/);
    expect(() => assertFeasible({ symbol: "SC", count: { 1: 1 }, reels: [9] }, 5)).toThrow(/no reels are eligible/);
  });

  test("rejects a nonsense count", () => {
    expect(() => assertFeasible({ symbol: "SC", count: { "-1": 1 } }, 5)).toThrow(/non-negative integer/);
    expect(() => assertFeasible({ symbol: "SC", count: {} }, 5)).toThrow(/empty/);
  });
});

describe("determinism", () => {
  test("the same stream gives the same spawn", () => {
    const gen = withScatters(() => board(), CFG);
    expect(gen(mulberry32(88)).cells).toEqual(gen(mulberry32(88)).cells);
  });

  test("a zero draw consumes exactly one float and touches nothing", () => {
    let calls = 0;
    const r = spawnOn(board(), { symbol: "SC", count: { 0: 1 } }, () => { calls++; return 0.5; });
    expect(calls).toBe(1);
    expect(r.spawned).toBe(0);
    expect(r.positions).toEqual([]);
  });
});
