// Hold & win: the genre's rules, each asserted on its own.
//
// The cases that matter most are the ones where a plausible implementation is
// subtly wrong in a way that only shows up as a broken max win months later:
// a locked coin being overwritten, a collected coin being collected twice, an
// upgrade running off the top of the ladder, and the respin counter resetting
// when it should not.

import { describe, expect, test } from "bun:test";
import { fromColumns, makeGrid, rect, sizeOf } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import {
  type Cell, type JackpotTable, type RespinConfig,
  TIERS, beginRespins, cashCells, coin, coinCells, coinCount, coinSet,
  coinsShortOfTrigger, collector, emptyCells, isCycleOver, jackpot, mixedCoinSet,
  multiplier, payer, settleRespins, spawner, stepRespins, tierCells, totalValue,
  triggers, upgrader, valueOf,
} from "../src/index.js";

const JP: JackpotTable = { MINI: 10, MINOR: 25, MAJOR: 100, GRAND: 1000 };
const CFG: RespinConfig = { respins: 3, fullBoardAward: "GRAND" };
const NO_RNG = () => { throw new Error("effect drew randomness it should not need"); };
const R = (n: number) => () => n;

/** 5x3 with coins at the given flat indices - the classic hold & win board. */
function board(coinsAt: Record<number, Cell>): ReturnType<typeof makeGrid<Cell>> {
  let i = 0;
  return makeGrid<Cell>(rect(5, 3), () => coinsAt[i++] ?? null);
}

describe("trigger - 6 coins on a 5x3", () => {
  test("6 coins triggers, 5 does not", () => {
    const five = board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1), 4: coin(1) });
    const six = board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1), 4: coin(1), 5: coin(1) });
    expect(triggers(five, 6)).toBe(false);
    expect(triggers(six, 6)).toBe(true);
  });

  test("more than the minimum still triggers", () => {
    const many = board(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [i, coin(1)])));
    expect(triggers(many, 6)).toBe(true);
  });

  test("coinsShortOfTrigger is the number a tease is built around", () => {
    expect(coinsShortOfTrigger(board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1) }), 6)).toBe(2);
    expect(coinsShortOfTrigger(board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1), 4: coin(1) }), 6)).toBe(1);
    expect(coinsShortOfTrigger(board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1), 4: coin(1), 5: coin(1) }), 6)).toBe(0);
  });
});

describe("jackpot tiers", () => {
  test("the ladder is MINI < MINOR < MAJOR < GRAND", () => {
    expect(TIERS).toEqual(["MINI", "MINOR", "MAJOR", "GRAND"]);
    let prev = -Infinity;
    for (const t of TIERS) { expect(JP[t]).toBeGreaterThan(prev); prev = JP[t]; }
  });

  test("a tier coin resolves through the table, not its own number", () => {
    // So an upgrade changes the TIER and the ladder stays authoritative in one
    // place - retuning GRAND must not require touching every coin.
    expect(valueOf(jackpot("GRAND"), JP)).toBe(1000);
    expect(valueOf(jackpot("MINI"), JP)).toBe(10);
    expect(valueOf(coin(7), JP)).toBe(7);
  });

  test("totalValue sums cash and tiers together", () => {
    const g = board({ 0: coin(5), 1: jackpot("MAJOR"), 2: coin(2) });
    expect(totalValue(g, JP)).toBe(5 + 100 + 2);
  });
});

describe("the respin cycle", () => {
  const start = () => beginRespins(board({ 0: coin(1), 1: coin(1), 2: coin(1), 3: coin(1), 4: coin(1), 5: coin(1) }), CFG);

  test("begins with the configured respins", () => {
    expect(start().respinsLeft).toBe(3);
    expect(start().spins).toBe(0);
  });

  test("a blank respin burns one", () => {
    const s = stepRespins(start(), [], CFG);
    expect(s.respinsLeft).toBe(2);
    expect(s.spins).toBe(1);
  });

  test("a landing RESETS the counter rather than decrementing it", () => {
    // The defining rule of the genre, and the reason a cycle is unbounded in
    // principle - which is why a max-win cap is not optional.
    let s = stepRespins(start(), [], CFG);
    s = stepRespins(s, [], CFG);
    expect(s.respinsLeft).toBe(1);
    s = stepRespins(s, [[{ col: 2, row: 0 }, coin(2)]], CFG);
    expect(s.respinsLeft).toBe(3);
  });

  test("a coin cannot land on an already-locked cell", () => {
    // Overwriting a locked coin would let a long cycle repeatedly replace a
    // high coin with a low one - or worse, the reverse.
    const s0 = start();
    const before = totalValue(s0.grid, JP);
    const s1 = stepRespins(s0, [[{ col: 0, row: 0 }, coin(999)]], CFG);
    expect(totalValue(s1.grid, JP)).toBe(before);
    expect(s1.respinsLeft).toBe(2); // treated as a blank, since nothing landed
  });

  test("runs out and reports the cycle over", () => {
    let s = start();
    for (let i = 0; i < 3; i++) s = stepRespins(s, [], CFG);
    expect(s.respinsLeft).toBe(0);
    expect(isCycleOver(s)).toBe(true);
  });

  test("stepping a finished cycle is a no-op", () => {
    let s = start();
    for (let i = 0; i < 3; i++) s = stepRespins(s, [], CFG);
    expect(stepRespins(s, [[{ col: 4, row: 2 }, coin(5)]], CFG)).toBe(s);
  });

  test("filling the board ends the cycle and pays the full-board tier", () => {
    const nearlyFull = makeGrid<Cell>(rect(5, 3), ({ col, row }) =>
      (col === 4 && row === 2 ? null : coin(1)));
    let s = beginRespins(nearlyFull, CFG);
    expect(s.full).toBe(false);
    s = stepRespins(s, [[{ col: 4, row: 2 }, coin(1)]], CFG);
    expect(s.full).toBe(true);
    expect(isCycleOver(s)).toBe(true);
    // 15 cash coins + the GRAND for filling
    expect(settleRespins(s, CFG, JP)).toBe(15 + 1000);
  });

  test("no full-board award when the game does not offer one", () => {
    const cfg: RespinConfig = { respins: 3 };
    const full = makeGrid<Cell>(rect(5, 3), () => coin(1));
    const s = beginRespins(full, cfg);
    expect(settleRespins(s, cfg, JP)).toBe(15);
  });
});

describe("COLLECTOR", () => {
  test("absorbs every other coin's value into itself", () => {
    const g = board({ 0: coin(5), 1: coin(3), 2: coin(2) });
    const out = collector(coinCells(), JP)(g, { col: 0, row: 0 }, NO_RNG);
    expect(out.cells[0]).toEqual({ value: 10 });
    expect(totalValue(out, JP)).toBe(10);
  });

  test("a collected coin is emptied, not removed - the board can still fill", () => {
    const g = board({ 0: coin(5), 1: coin(3) });
    const out = collector(coinCells(), JP)(g, { col: 0, row: 0 }, NO_RNG);
    expect(coinCount(out)).toBe(2);          // still two occupied cells
    expect(out.cells[1]).toEqual({ value: 0 }); // but worth nothing
  });

  test("collecting twice does not double-count", () => {
    // Without emptying, a long cycle could harvest the same cell repeatedly
    // and the max win would stop being bounded by the grid.
    const g = board({ 0: coin(5), 1: coin(3) });
    const once = collector(coinCells(), JP)(g, { col: 0, row: 0 }, NO_RNG);
    const twice = collector(coinCells(), JP)(once, { col: 0, row: 0 }, NO_RNG);
    expect(totalValue(twice, JP)).toBe(8);
  });

  test("collects jackpot value through the table", () => {
    const g = board({ 0: coin(1), 1: jackpot("MAJOR") });
    const out = collector(coinCells(), JP)(g, { col: 0, row: 0 }, NO_RNG);
    expect(totalValue(out, JP)).toBe(101);
  });

  test("a narrower selector collects only what it targets", () => {
    // "collect cash, leave the jackpots" is a selector, not a new engine.
    const g = board({ 0: coin(1), 1: coin(4), 2: jackpot("MINI") });
    const out = collector(cashCells(), JP)(g, { col: 0, row: 0 }, NO_RNG);
    expect(out.cells[2]).toEqual(jackpot("MINI")); // untouched
    expect(out.cells[0]).toEqual({ value: 5 });
  });
});

describe("PAYER and MULTIPLIER", () => {
  test("payer adds its amount to each cash coin", () => {
    const g = board({ 0: coin(0), 1: coin(2), 2: coin(3) });
    const out = payer(5, coinCells())(g, { col: 0, row: 0 }, NO_RNG);
    expect(out.cells[1]).toEqual({ value: 7 });
    expect(out.cells[2]).toEqual({ value: 8 });
  });

  test("multiplier scales each cash coin", () => {
    const g = board({ 0: coin(0), 1: coin(2), 2: coin(3) });
    const out = multiplier(3, coinCells())(g, { col: 0, row: 0 }, NO_RNG);
    expect(out.cells[1]).toEqual({ value: 6 });
    expect(out.cells[2]).toEqual({ value: 9 });
  });

  test("neither touches a jackpot tier", () => {
    // A "2x GRAND" is not a rung on the ladder; letting it exist would make
    // the tier mean two different things.
    const g = board({ 0: coin(0), 1: jackpot("GRAND") });
    expect(payer(5, coinCells())(g, { col: 0, row: 0 }, NO_RNG).cells[1]).toEqual(jackpot("GRAND"));
    expect(multiplier(2, coinCells())(g, { col: 0, row: 0 }, NO_RNG).cells[1]).toEqual(jackpot("GRAND"));
  });

  test("multiplier rejects a negative factor at build time", () => {
    expect(() => multiplier(-1)).toThrow(/non-negative/);
  });

  test("neither affects empty cells", () => {
    const g = board({ 0: coin(0), 1: coin(2) });
    const out = payer(5, coinCells())(g, { col: 0, row: 0 }, NO_RNG);
    expect(out.cells[5]).toBeNull();
  });
});

describe("UPGRADER", () => {
  test("bumps a tier one rung up the ladder", () => {
    const g = board({ 0: coin(0), 1: jackpot("MINI") });
    const out = upgrader(tierCells(["MINI"]))(g, { col: 0, row: 0 }, R(0));
    expect(out.cells[1]).toEqual(jackpot("MINOR"));
  });

  test("a cash coin becomes MINI", () => {
    const g = board({ 0: coin(0), 1: coin(7) });
    const out = upgrader(cashCells())(g, { col: 0, row: 0 }, R(0));
    expect(out.cells[1]).toEqual(jackpot("MINI"));
  });

  test("GRAND is the top and stays put", () => {
    // Rather than wrapping, or overflowing into a fifth tier with no name and
    // no value in the table.
    const g = board({ 0: coin(0), 1: jackpot("GRAND") });
    const out = upgrader(tierCells(["GRAND"]))(g, { col: 0, row: 0 }, R(0));
    expect(out.cells[1]).toEqual(jackpot("GRAND"));
  });

  test("walks the whole ladder in order", () => {
    let g = board({ 0: coin(0), 1: coin(1) });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      g = upgrader(coinCells())(g, { col: 0, row: 0 }, R(0));
      seen.push(String((g.cells[1] as { tier?: string }).tier));
    }
    expect(seen).toEqual(["MINI", "MINOR", "MAJOR", "GRAND", "GRAND"]);
  });
});

describe("SPAWNER", () => {
  const coins = coinSet({ "1": 1 });

  test("creates coins in empty cells only", () => {
    const g = board({ 0: coin(9) });
    const out = spawner(3, coins, emptyCells())(g, { col: 0, row: 0 }, R(0.5));
    expect(coinCount(out)).toBe(4);
    expect(out.cells[0]).toEqual({ value: 9 }); // existing coin untouched
  });

  test("is bounded by how many cells are actually empty", () => {
    // A spawner resets the respin counter, so an unbounded one makes cycles
    // that never end.
    const nearlyFull = makeGrid<Cell>(rect(5, 3), ({ col, row }) =>
      (col === 4 && row === 2 ? null : coin(1)));
    const out = spawner(10, coins, emptyCells())(nearlyFull, { col: 0, row: 0 }, R(0.5));
    expect(coinCount(out)).toBe(sizeOf(rect(5, 3)));
  });

  test("spawns nothing on a full board", () => {
    const full = makeGrid<Cell>(rect(5, 3), () => coin(1));
    const out = spawner(5, coins, emptyCells())(full, { col: 0, row: 0 }, R(0.5));
    expect(totalValue(out, JP)).toBe(15);
  });
});

describe("coin sets", () => {
  test("coinSet builds bet-multiple cash coins", () => {
    const s = coinSet({ "1": 50, "2": 30, "5": 20 });
    expect(s.probabilityOf(coin(1))).toBe(0); // identity, not structural
    const drawn = s.pick(0.1);
    expect(drawn.value).toBe(1);
    expect(s.pick(0.9).value).toBe(5);
  });

  test("mixedCoinSet folds jackpot tiers in alongside cash", () => {
    const s = mixedCoinSet([{ item: coin(1), weight: 90 }], { MINI: 8, GRAND: 2 });
    const tiers = s.items.filter((c) => c.tier).map((c) => c.tier);
    expect(tiers).toEqual(["MINI", "GRAND"]);
    // GRAND at 2 of 100
    const grandIdx = s.items.findIndex((c) => c.tier === "GRAND");
    expect(s.weights[grandIdx]! / s.total).toBeCloseTo(0.02, 12);
  });

  test("a tier can be given zero weight and never appear", () => {
    const s = mixedCoinSet([{ item: coin(1), weight: 1 }], { GRAND: 0 });
    for (let i = 0; i < 1000; i++) expect(s.pick(i / 1000).tier).toBeUndefined();
  });
});

describe("a whole cycle end to end", () => {
  test("trigger, respin, collect, fill, settle", () => {
    // 6 coins on a 5x3 -> feature. Then a collector lands and harvests.
    const trigger = board({ 0: coin(1), 1: coin(1), 2: coin(2), 3: coin(2), 4: coin(3), 5: coin(3) });
    expect(triggers(trigger, 6)).toBe(true);

    let s = beginRespins(trigger, CFG);
    expect(s.respinsLeft).toBe(3);

    s = stepRespins(s, [[{ col: 2, row: 0 }, coin(4)]], CFG);
    expect(s.respinsLeft).toBe(3);   // reset by the landing
    expect(totalValue(s.grid, JP)).toBe(16);

    const collected = collector(coinCells(), JP)(s.grid, { col: 2, row: 0 }, NO_RNG);
    expect(totalValue(collected, JP)).toBe(16); // value conserved, not created

    s = { ...s, grid: collected };
    for (let i = 0; i < 3; i++) s = stepRespins(s, [], CFG);
    expect(isCycleOver(s)).toBe(true);
    expect(settleRespins(s, CFG, JP)).toBe(16);
  });
});
