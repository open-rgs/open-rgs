// The bookkeeping between spins is where free-spin features go wrong: a spin
// paid at the wrong multiplier, a retrigger that resets instead of adding, a
// sticky symbol that is only sticky on the spin it landed. Each of those is a
// test here.

import { describe, expect, test } from "bun:test";
import { makeGrid, rect, type Grid } from "@open-rgs/grid";
import {
  type FreeSpinConfig, applySticky, beginFreeSpins, bumpMultiplier, isFeatureOver,
  multiplierAt, playSpin, retrigger, runFreeSpins, setMultiplier, spinsFor, stick,
  stickCell, stuckCount, triggerAt, triggers,
} from "../src/index.js";

const TABLE = { 3: 10, 4: 15, 5: 25 };

describe("trigger table", () => {
  test("reads the paytable's own numbers", () => {
    expect(spinsFor(TABLE, 3)).toBe(10);
    expect(spinsFor(TABLE, 5)).toBe(25);
    expect(triggers(TABLE, 2)).toBe(false);
    expect(triggerAt(TABLE)).toBe(3);
  });

  test("more scatters than the table lists awards its top entry", () => {
    // A six-scatter board is a better board, not a broken one.
    expect(spinsFor(TABLE, 6)).toBe(25);
    expect(spinsFor(TABLE, 40)).toBe(25);
  });

  test("nonsense counts award nothing rather than throwing mid-spin", () => {
    expect(spinsFor(TABLE, -1)).toBe(0);
    expect(spinsFor(TABLE, 1.5)).toBe(0);
    expect(spinsFor({}, 5)).toBe(0);
  });
});

describe("the multiplier a spin is paid at", () => {
  const cfg: FreeSpinConfig = { ladder: { steps: [1, 2, 3, 5] } };

  test("a spin pays at the multiplier showing when it was played", () => {
    let s = beginFreeSpins(4, cfg);
    expect(s.multiplier).toBe(1);
    s = playSpin(s, 10, cfg);            // paid at 1x, ladder then moves to 2x
    expect(s.total).toBe(10);
    expect(s.multiplier).toBe(2);
    s = playSpin(s, 10, cfg);            // paid at 2x
    expect(s.total).toBe(30);
    expect(s.multiplier).toBe(3);
  });

  test("the last ladder step repeats", () => {
    const ladder = { steps: [1, 2, 3, 5] };
    expect(multiplierAt(ladder, 3)).toBe(5);
    expect(multiplierAt(ladder, 99)).toBe(5);
    expect(multiplierAt({ steps: [] }, 2)).toBe(1);
  });

  test("'per-win' holds the ladder still on a losing spin", () => {
    const perWin: FreeSpinConfig = { ladder: { steps: [1, 2, 3], advance: "per-win" } };
    let s = beginFreeSpins(3, perWin);
    s = playSpin(s, 0, perWin);
    expect(s.multiplier).toBe(1);        // no win, no climb
    s = playSpin(s, 4, perWin);
    expect(s.total).toBe(4);
    expect(s.multiplier).toBe(2);
  });

  test("'manual' leaves it entirely to the game", () => {
    const manual: FreeSpinConfig = { ladder: { steps: [1, 2, 3], advance: "manual" } };
    let s = beginFreeSpins(3, manual);
    s = playSpin(s, 5, manual);
    expect(s.multiplier).toBe(1);
    s = bumpMultiplier(s, 4);
    expect(s.multiplier).toBe(5);
    s = playSpin(s, 5, manual);
    expect(s.total).toBe(5 + 25);
    s = setMultiplier(s, 2);
    expect(s.multiplier).toBe(2);
    expect(bumpMultiplier(s, -100).multiplier).toBe(0);   // never negative
  });

  test("no ladder is a flat 1x", () => {
    let s = beginFreeSpins(2);
    s = playSpin(s, 7);
    expect(s.total).toBe(7);
    expect(s.multiplier).toBe(1);
  });
});

describe("retriggers", () => {
  test("add to what is left rather than resetting it", () => {
    let s = beginFreeSpins(10);
    s = playSpin(s, 0);                  // 9 left
    s = retrigger(s, 5);
    expect(s.spinsLeft).toBe(14);
    expect(s.retriggers).toBe(1);
  });

  test("a cap bounds the total spins retriggers can award", () => {
    const cfg: FreeSpinConfig = { maxRetriggerSpins: 6 };
    let s = beginFreeSpins(5, cfg);
    s = retrigger(s, 5, cfg);
    s = retrigger(s, 5, cfg);            // only 1 of these is allowed
    expect(s.retriggerSpins).toBe(6);
    expect(s.spinsLeft).toBe(11);
    expect(retrigger(s, 5, cfg)).toBe(s);  // nothing left to award
  });

  test("zero is a no-op, negatives are a mistake", () => {
    const s = beginFreeSpins(5);
    expect(retrigger(s, 0)).toBe(s);
    expect(() => retrigger(s, -1)).toThrow(/non-negative/);
  });
});

describe("sticky cells", () => {
  const board = (): Grid<string> => makeGrid(rect(3, 3), () => "LOW");

  test("a held cell is written onto every later board", () => {
    const layer = stick(stick([], { col: 0, row: 0 }, "WILD"), { col: 2, row: 2 }, "WILD");
    const out = applySticky(board(), layer);
    expect(out.cells[0]).toBe("WILD");
    expect(out.cells[8]).toBe("WILD");
    expect(stuckCount(layer)).toBe(2);
  });

  test("sticking the same cell twice replaces rather than stacking", () => {
    const layer = stick(stick([], { col: 1, row: 1 }, "WILD"), { col: 1, row: 1 }, "W3");
    expect(layer).toHaveLength(1);
    expect(applySticky(board(), layer).cells[4]).toBe("W3");
  });

  test("a cell outside a smaller board is skipped, not a crash", () => {
    const layer = stick([], { col: 9, row: 9 }, "WILD");
    expect(applySticky(board(), layer).cells.every((c) => c === "LOW")).toBe(true);
  });
});

describe("running the feature", () => {
  const cfg: FreeSpinConfig = { ladder: { steps: [1, 2, 3, 5] } };
  const next = () => 0.5;

  test("plays every spin and totals what they paid", () => {
    const s = runFreeSpins(beginFreeSpins(3, cfg), () => ({ win: 2 }), next, cfg);
    expect(s.spinsPlayed).toBe(3);
    expect(isFeatureOver(s)).toBe(true);
    expect(s.total).toBe(2 * 1 + 2 * 2 + 2 * 3);
  });

  test("a retrigger inside the loop extends it", () => {
    let fired = false;
    const s = runFreeSpins(beginFreeSpins(2, cfg), () => {
      if (fired) return { win: 1 };
      fired = true;
      return { win: 1, retrigger: 3 };
    }, next, cfg);
    expect(s.spinsPlayed).toBe(5);
    expect(s.retriggers).toBe(1);
  });

  test("cells held mid-feature are held for the spins that follow", () => {
    const s = runFreeSpins(beginFreeSpins(3, cfg), (state) =>
      state.spinsPlayed === 0 ? { win: 0, stick: [[{ col: 0, row: 0 }, "WILD"] as const] } : { win: 0 },
    next, cfg);
    expect(stuckCount(s.sticky)).toBe(1);
  });

  test("maxSpins stops a feature that retriggers forever", () => {
    const s = runFreeSpins(beginFreeSpins(1), () => ({ win: 0, retrigger: 1 }), next, {}, { maxSpins: 20 });
    expect(s.spinsPlayed).toBe(20);
  });

  test("a played spin never runs past the end of the feature", () => {
    let s = beginFreeSpins(1);
    s = playSpin(s, 5);
    const after = playSpin(s, 100);
    expect(after).toBe(s);               // no spins left, nothing paid
    expect(after.total).toBe(5);
  });
});
