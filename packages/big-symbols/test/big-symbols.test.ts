// Big symbols are written as the same symbol repeated across every covered
// cell - no overlay, no marker. That choice is the design, and these tests are
// mostly about the two places it can go wrong: fit on a ragged board, and a
// block that gets clipped instead of refused.

import { describe, expect, test } from "bun:test";
import { at, countOf, fromColumns, makeGrid, rect } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import {
  blocksOf, cellsOf, fits, placeBig, placeDrawnBig, placeRandomBig, placements, weightOfBlock,
} from "../src/index.js";

const R55 = rect(5, 5);
const blank = () => makeGrid(R55, () => "X");
// Ragged: reel 2 is only 2 tall, so a 2x2 cannot span reels 1-2 low down.
const RAGGED = fromColumns([
  ["X", "X", "X", "X"],
  ["X", "X", "X", "X"],
  ["X", "X"],
  ["X", "X", "X", "X"],
]);

describe("fit", () => {
  test("a block inside the grid fits", () => {
    expect(fits(R55, { col: 0, row: 0 }, 2, 2)).toBe(true);
    expect(fits(R55, { col: 3, row: 3 }, 2, 2)).toBe(true);
  });

  test("a block running off the right edge does not", () => {
    expect(fits(R55, { col: 4, row: 0 }, 2, 2)).toBe(false);
  });

  test("a block running off the bottom does not", () => {
    expect(fits(R55, { col: 0, row: 4 }, 2, 2)).toBe(false);
  });

  test("EVERY covered column must be tall enough, not just the first", () => {
    // The check that actually bites on a ragged board: reel 2 has only 2 rows,
    // so a 2x2 at (1,2) fits in its own column and not in its neighbour.
    expect(fits(RAGGED.shape, { col: 1, row: 2 }, 2, 2)).toBe(false);
    expect(fits(RAGGED.shape, { col: 0, row: 2 }, 2, 2)).toBe(true);
    expect(fits(RAGGED.shape, { col: 2, row: 0 }, 2, 2)).toBe(true);
  });

  test("degenerate sizes never fit", () => {
    expect(fits(R55, { col: 0, row: 0 }, 0, 2)).toBe(false);
    expect(fits(R55, { col: 0, row: 0 }, 2, -1)).toBe(false);
    expect(fits(R55, { col: -1, row: 0 }, 2, 2)).toBe(false);
  });

  test("a block bigger than the board never fits", () => {
    expect(placements(R55, 9, 9)).toEqual([]);
  });
});

describe("placements", () => {
  test("counts the legal top-left corners", () => {
    expect(placements(R55, 2, 2)).toHaveLength(16); // 4 x 4
    expect(placements(R55, 1, 1)).toHaveLength(25);
    expect(placements(R55, 5, 5)).toHaveLength(1);
  });

  test("a short reel removes the placements that would span it", () => {
    const all = placements(RAGGED.shape, 2, 2);
    for (const p of all) expect(fits(RAGGED.shape, p, 2, 2)).toBe(true);
    expect(all.some((p) => p.col === 1 && p.row === 2)).toBe(false);
  });
});

describe("placing", () => {
  test("writes the symbol across every covered cell", () => {
    const g = placeBig(blank(), { pos: { col: 1, row: 1 }, width: 2, height: 2 }, "BIG");
    expect(countOf(g, "BIG")).toBe(4);
    for (const [c, r] of [[1, 1], [1, 2], [2, 1], [2, 2]]) expect(at(g, c!, r!)).toBe("BIG");
    expect(at(g, 0, 0)).toBe("X");
  });

  test("REFUSES rather than clipping", () => {
    // A clipped 2x2 is a 2x1 pretending to be a 2x2: it pays less than the game
    // promised, and by then it is just symbols - nothing downstream can tell.
    expect(() => placeBig(blank(), { pos: { col: 4, row: 4 }, width: 2, height: 2 }, "BIG"))
      .toThrow(/does not fit/);
    expect(() => placeBig(RAGGED, { pos: { col: 1, row: 2 }, width: 2, height: 2 }, "BIG"))
      .toThrow(/does not fit/);
  });

  test("cellsOf reports the covered indices, or none when it does not fit", () => {
    expect(cellsOf(R55, { pos: { col: 0, row: 0 }, width: 2, height: 3 })).toHaveLength(6);
    expect(cellsOf(R55, { pos: { col: 4, row: 4 }, width: 2, height: 2 })).toEqual([]);
  });

  test("weightOfBlock is just its area - which is why evaluators need no changes", () => {
    expect(weightOfBlock({ pos: { col: 0, row: 0 }, width: 2, height: 3 })).toBe(6);
  });
});

describe("random placement", () => {
  test("places somewhere legal and consumes one float", () => {
    let calls = 0;
    const g = placeRandomBig(blank(), "BIG", 2, 2, () => { calls++; return 0.5; });
    expect(countOf(g, "BIG")).toBe(4);
    expect(calls).toBe(1);
  });

  test("returns the grid UNCHANGED when nothing fits, rather than throwing", () => {
    // On a multiways board a 3x3 genuinely may not fit some spins. A feature
    // that cannot place is an outcome to price, not an error to crash on.
    const tiny = makeGrid([2, 2], () => "X");
    let calls = 0;
    const g = placeRandomBig(tiny, "BIG", 3, 3, () => { calls++; return 0.5; });
    expect(countOf(g, "BIG")).toBe(0);
    expect(calls).toBe(0); // and draws nothing
  });

  test("an rng of exactly 1 cannot index past the last placement", () => {
    const g = placeRandomBig(blank(), "BIG", 2, 2, () => 1);
    expect(countOf(g, "BIG")).toBe(4);
  });

  test("every legal spot is reachable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const g = placeRandomBig(blank(), "BIG", 2, 2, () => i / 400);
      const first = g.cells.findIndex((s) => s === "BIG");
      seen.add(String(first));
    }
    expect(seen.size).toBe(16);
  });

  test("placeDrawnBig picks the size too", () => {
    const sizes = sampler([{ item: [2, 2] as const, weight: 1 }, { item: [3, 3] as const, weight: 1 }]);
    const small = placeDrawnBig(blank(), "BIG", sizes, (() => { let i = 0; return () => [0.1, 0.5][i++]!; })());
    expect(countOf(small, "BIG")).toBe(4);
    const big = placeDrawnBig(blank(), "BIG", sizes, (() => { let i = 0; return () => [0.9, 0.5][i++]!; })());
    expect(countOf(big, "BIG")).toBe(9);
  });
});

describe("recovering blocks for presentation", () => {
  test("finds a placed block", () => {
    const g = placeBig(blank(), { pos: { col: 1, row: 1 }, width: 2, height: 2 }, "BIG");
    const found = blocksOf(g, "BIG", [[2, 2]]);
    expect(found).toHaveLength(1);
    expect(found[0]!.pos).toEqual({ col: 1, row: 1 });
  });

  test("finds nothing when the symbol is absent", () => {
    expect(blocksOf(blank(), "BIG", [[2, 2]])).toEqual([]);
  });

  test("prefers the largest size when several are offered", () => {
    const g = placeBig(blank(), { pos: { col: 0, row: 0 }, width: 3, height: 3 }, "BIG");
    const found = blocksOf(g, "BIG", [[2, 2], [3, 3]]);
    expect(found[0]!.width).toBe(3);
    expect(found).toHaveLength(1);
  });

  test("blocks never overlap in the result", () => {
    let g = placeBig(blank(), { pos: { col: 0, row: 0 }, width: 2, height: 2 }, "BIG");
    g = placeBig(g, { pos: { col: 3, row: 3 }, width: 2, height: 2 }, "BIG");
    const found = blocksOf(g, "BIG", [[2, 2]]);
    expect(found).toHaveLength(2);
    const cells = found.flatMap((b) => cellsOf(g.shape, b));
    expect(new Set(cells).size).toBe(cells.length);
  });
});
