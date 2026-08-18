// Gravity is the part that looks trivial and is not. On a ragged grid a short
// reel drops its symbols a shorter distance, and any implementation that
// treats the board as a rectangle produces a shuffle instead of a fall - which
// still looks plausible on screen.

import { describe, expect, test } from "bun:test";
import { at, column, fromColumns, makeGrid, rect , toColumns } from "@open-rgs/grid";
import { clear, collapse, holeCount, multiplierForStep, refill, refillAvoiding, refillFrom, refillPerColumn, runCascade, tumble, type Holed } from "../src/index.js";

const seq = (xs: string[]) => { let i = 0; return () => xs[i++ % xs.length]!; };
/** A picker that ignores randomness, so refills are readable in assertions. */
const picker = (xs: string[]) => { const g = seq(xs); return () => g(); };

describe("clear", () => {
  test("punches holes at the given indices", () => {
    const g = fromColumns([["A", "B"], ["C", "D"]]);
    const h = clear(g, [0, 3]);
    expect(h.cells).toEqual([null, "B", "C", null]);
  });

  test("duplicate indices collapse to one hole", () => {
    // Two crossing paylines legitimately share a cell. Counting it twice makes
    // the refill draw more symbols than there are holes.
    const g = fromColumns([["A", "B"], ["C", "D"]]);
    expect(holeCount(clear(g, [1, 1, 1]))).toBe(1);
  });

  test("clearing nothing leaves the board intact", () => {
    const g = fromColumns([["A", "B"]]);
    expect(clear(g, []).cells).toEqual(["A", "B"]);
  });
});

describe("collapse - gravity", () => {
  test("symbols fall to the bottom, holes rise to the top", () => {
    // Row 0 is the top, so after gravity the nulls sit at the low indices.
    const g = fromColumns([["A", null, "B", null]]);
    expect(collapse(g).cells).toEqual([null, null, "A", "B"]);
  });

  test("order is preserved among survivors", () => {
    const g = fromColumns([["A", null, "B", "C"]]);
    expect(collapse(g).cells).toEqual([null, "A", "B", "C"]);
  });

  test("a full column does not move", () => {
    const g = fromColumns([["A", "B", "C"]]);
    expect(collapse(g).cells).toEqual(["A", "B", "C"]);
  });

  test("an empty column stays empty", () => {
    const g = fromColumns([[null, null, null]]);
    expect(collapse(g).cells).toEqual([null, null, null]);
  });

  test("columns fall INDEPENDENTLY - nothing crosses between reels", () => {
    // The bug this guards: treating the flat array as one column mixes symbols
    // between reels, which reads as a shuffle rather than a fall.
    const g = fromColumns([
      ["A", null, null],
      [null, null, "B"],
    ]);
    const c = collapse(g);
    expect(column(c, 0)).toEqual([null, null, "A"]);
    expect(column(c, 1)).toEqual([null, null, "B"]);
  });

  test("a short reel drops its symbols a shorter distance", () => {
    const g = fromColumns([
      ["A", null, null, null],  // 4 tall
      ["B", null],              // 2 tall
    ]);
    const c = collapse(g);
    expect(column(c, 0)).toEqual([null, null, null, "A"]);
    expect(column(c, 1)).toEqual([null, "B"]);
  });
});

describe("refill", () => {
  test("fills only the holes", () => {
    const g = fromColumns([[null, "B"], ["C", null]]);
    expect(refill(g, picker(["X", "Y"]), () => 0).cells).toEqual(["X", "B", "C", "Y"]);
  });

  test("draws once per hole, in column-major order", () => {
    // The order matters: a seeded replay must refill identically.
    const g = fromColumns([[null, null], [null, null]]);
    let calls = 0;
    const out = refill(g, () => `s${calls++}`, () => 0);
    expect(out.cells).toEqual(["s0", "s1", "s2", "s3"]);
    expect(calls).toBe(4);
  });

  test("a board with no holes draws nothing", () => {
    const g = fromColumns([["A", "B"]]);
    let calls = 0;
    refill(g, () => { calls++; return "X"; }, () => 0);
    expect(calls).toBe(0);
  });
});

describe("tumble", () => {
  test("clears, falls and refills in one move", () => {
    const g = fromColumns([["A", "B", "C"]]);
    // Clear the middle: C falls onto B's place, a new symbol lands on top.
    const out = tumble(g, [1], picker(["NEW"]), () => 0);
    expect(out.cells).toEqual(["NEW", "A", "C"]);
  });
});

describe("the multiplier ladder", () => {
  test("walks the ladder then repeats its last value", () => {
    const ladder = [1, 2, 3, 5];
    expect([1, 2, 3, 4, 5, 9].map((s) => multiplierForStep(s, ladder))).toEqual([1, 2, 3, 5, 5, 5]);
  });

  test("an empty ladder is a flat 1", () => {
    expect(multiplierForStep(3, [])).toBe(1);
  });
});

describe("runCascade", () => {
  const g0 = makeGrid(rect(2, 2), () => "A");

  test("stops as soon as nothing wins", () => {
    const r = runCascade(g0, () => ({ multiplier: 0, positions: [] }), () => "A", () => 0);
    expect(r.steps).toEqual([]);
    expect(r.multiplier).toBe(0);
    expect(r.truncated).toBe(false);
  });

  test("a multiplier with NO positions still stops", () => {
    // Clearing nothing refills nothing, so the next board is identical - an
    // infinite loop, not a win.
    const r = runCascade(g0, () => ({ multiplier: 5, positions: [] }), () => "A", () => 0);
    expect(r.steps).toEqual([]);
    expect(r.multiplier).toBe(0);
  });

  test("runs until the board goes quiet", () => {
    // Wins on the first two boards, then nothing.
    let n = 0;
    const r = runCascade(
      g0,
      () => (n++ < 2 ? { multiplier: 10, positions: [0] } : { multiplier: 0, positions: [] }),
      () => "A",
      () => 0,
    );
    expect(r.steps).toHaveLength(2);
    expect(r.multiplier).toBe(20);
  });

  test("the ladder applies to each step's OWN win, never retroactively", () => {
    // 10 at x1, then 10 at x2 = 30. Applying the ladder to the running total
    // would give 10 then (10+10)*2 = 30... so use distinct wins to catch it:
    // 10 at x1 + 20 at x2 = 50, whereas compounding gives (10+20)*2 = 60.
    let n = 0;
    const wins = [
      { multiplier: 10, positions: [0] },
      { multiplier: 20, positions: [1] },
      { multiplier: 0, positions: [] },
    ];
    const r = runCascade(g0, () => wins[n++]!, () => "A", () => 0, { stepMultipliers: [1, 2, 3] });
    expect(r.steps.map((s) => s.paid)).toEqual([10, 40]);
    expect(r.multiplier).toBe(50);
  });

  test("reports each step's parts separately", () => {
    let n = 0;
    const r = runCascade(
      g0,
      () => (n++ === 0 ? { multiplier: 7, positions: [0, 1] } : { multiplier: 0, positions: [] }),
      () => "A",
      () => 0,
      { stepMultipliers: [3] },
    );
    const s = r.steps[0]!;
    expect(s.step).toBe(1);
    expect(s.baseMultiplier).toBe(7);
    expect(s.stepMultiplier).toBe(3);
    expect(s.paid).toBe(21);
    expect(s.cleared).toEqual([0, 1]);
  });

  test("de-duplicates overlapping wins before clearing", () => {
    let n = 0;
    const r = runCascade(
      g0,
      () => (n++ === 0 ? { multiplier: 1, positions: [0, 0, 1, 1, 1] } : { multiplier: 0, positions: [] }),
      () => "A",
      () => 0,
    );
    expect(r.steps[0]!.cleared).toEqual([0, 1]);
  });

  test("a self-sustaining board is CAPPED rather than hanging", () => {
    // A refill can always produce another win. Unbounded, this spins forever.
    const r = runCascade(
      g0,
      () => ({ multiplier: 1, positions: [0] }),
      () => "A",
      () => 0,
      { maxSteps: 12 },
    );
    expect(r.truncated).toBe(true);
    expect(r.steps).toHaveLength(12);
    expect(r.multiplier).toBe(12);
  });

  test("truncated is false for a run that ended naturally", () => {
    let n = 0;
    const r = runCascade(
      g0,
      () => (n++ === 0 ? { multiplier: 1, positions: [0] } : { multiplier: 0, positions: [] }),
      () => "A",
      () => 0,
      { maxSteps: 12 },
    );
    expect(r.truncated).toBe(false);
  });

  test("the final grid is the board after the last tumble", () => {
    let n = 0;
    const r = runCascade(
      makeGrid(rect(1, 2), () => "A"),
      () => (n++ === 0 ? { multiplier: 1, positions: [0] } : { multiplier: 0, positions: [] }),
      () => "NEW",
      () => 0,
    );
    expect(r.finalGrid.cells).toEqual(["NEW", "A"]);
  });

  test("is deterministic for the same stream", () => {
    const run = () => {
      let n = 0;
      const draws = seq(["P", "Q", "R", "S"]);
      return runCascade(
        makeGrid(rect(2, 2), () => "A"),
        () => (n++ < 2 ? { multiplier: 1, positions: [0, 2] } : { multiplier: 0, positions: [] }),
        () => draws(),
        () => 0,
      ).finalGrid.cells;
    };
    expect(run()).toEqual(run());
  });
});

describe("cascade on a ragged grid", () => {
  test("each reel refills only its own holes", () => {
    const g = fromColumns([["A", "A", "A"], ["B", "B"]]);
    let n = 0;
    const r = runCascade(
      g,
      () => (n++ === 0 ? { multiplier: 1, positions: [0, 1, 2] } : { multiplier: 0, positions: [] }),
      () => "N",
      () => 0,
    );
    // Column 0 cleared entirely and refilled with three; column 1 untouched.
    expect(column(r.finalGrid, 0)).toEqual(["N", "N", "N"]);
    expect(column(r.finalGrid, 1)).toEqual(["B", "B"]);
    expect(at(r.finalGrid, 1, 2)).toBeUndefined();
  });
});

describe("a step reports what fell in", () => {
  const symbols = ["N1", "N2", "N3", "N4", "N5", "N6"];
  let n = 0;
  const pick = () => symbols[n++ % symbols.length]!;

  test("refilled cells are the holes after gravity, at the top of each column", () => {
    // 2x3 board; clear the BOTTOM cell of column 0 -> survivors fall, the hole
    // ends up at the TOP of that column, not where the clear happened.
    const grid = fromColumns([["a", "b", "c"], ["d", "e", "f"]]);
    let seen: readonly number[] = [];
    runCascade(
      grid,
      (g) => (seen.length === 0 ? { multiplier: 1, positions: [2] } : { multiplier: 0, positions: [] }),
      pick,
      () => 0.5,
      { maxSteps: 2 },
    ).steps.forEach((s) => { if (s.step === 1) seen = s.refilled; });
    expect(seen).toEqual([0]);            // top of column 0
  });

  test("clearing a whole column refills all of it", () => {
    const grid = fromColumns([["a", "b"], ["c", "d"]]);
    const run = runCascade(
      grid,
      (g) => (g.cells[0] === "a" ? { multiplier: 1, positions: [0, 1] } : { multiplier: 0, positions: [] }),
      pick,
      () => 0.5,
      { maxSteps: 2 },
    );
    expect(run.steps[0]!.refilled).toEqual([0, 1]);
  });

  test("cleared and refilled are different lists", () => {
    const grid = fromColumns([["a", "b", "c"]]);
    const run = runCascade(
      grid,
      (g) => (g.cells[1] === "b" ? { multiplier: 1, positions: [1] } : { multiplier: 0, positions: [] }),
      pick,
      () => 0.5,
      { maxSteps: 2 },
    );
    expect(run.steps[0]!.cleared).toEqual([1]);   // the middle cell won
    expect(run.steps[0]!.refilled).toEqual([0]);  // the top one is what fell in
  });
});

describe("refill helpers", () => {
  const A = { pick: () => "A" };
  const B = { pick: () => "B" };
  const holed = (): Holed<string> => clear(fromColumns([["x", "y"], ["z", "w"]]), [0, 1, 2, 3]);

  test("refillPerColumn gives each column its own set", () => {
    const out = refillPerColumn(holed(), [A, B], () => 0.5);
    expect(toColumns(out)).toEqual([["A", "A"], ["B", "B"]]);
  });

  test("columns past the end of the list reuse the last set", () => {
    const g = clear(fromColumns([["x"], ["y"], ["z"]]), [0, 1, 2]);
    expect(toColumns(refillPerColumn(g, [A, B], () => 0.5))).toEqual([["A"], ["B"], ["B"]]);
  });

  test("refillPerColumn leaves surviving symbols alone", () => {
    const g = clear(fromColumns([["x", "y"]]), [0]);      // only the top cell is a hole
    expect(toColumns(refillPerColumn(g, [A], () => 0.5))).toEqual([["A", "y"]]);
  });

  test("an empty set list is a build-time error, not a blank board", () => {
    expect(() => refillPerColumn(holed(), [], () => 0.5)).toThrow(/at least one set/);
  });

  test("refillAvoiding retries a board that would win, and reports how often", () => {
    let calls = 0;
    const pick = () => (++calls <= 4 ? "WIN" : "SAFE");     // first two boards win
    const out = refillAvoiding(holed(), pick, () => 0.5, (g) => g.cells.includes("WIN"));
    expect(out.grid.cells.every((c) => c === "SAFE")).toBe(true);
    expect(out.rejected).toBe(1);
  });

  test("it gives up rather than spinning forever, because a spin must finish", () => {
    const out = refillAvoiding(holed(), () => "WIN", () => 0.5, () => true, 3);
    expect(out.rejected).toBe(3);
    expect(out.grid.cells.every((c) => c === "WIN")).toBe(true);
  });

  test("a board that does not win is taken on the first try", () => {
    const out = refillAvoiding(holed(), () => "SAFE", () => 0.5, () => false);
    expect(out.rejected).toBe(0);
  });
});
