// A complete slot, written against every library in the repo.
//
// This exists to prove the packages compose - it is the acceptance test for
// the API, not a shipping game. Deliberately small: 5x3, three straight
// paylines, one feature.
//
//   base game   markov-stacked reels, three paylines, wilds
//   teases      declared recipes, so their rate is priced and measurable
//   feature     6+ COIN triggers hold & win, MINI/MINOR/MAJOR/GRAND
//
// The whole thing is a pure function of a stream of floats. There is no
// ambient randomness anywhere, which is what makes `rngMode: "seed-expand"`
// able to replay any round from one recorded number.

import { type Grid, rect } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import { cols, randomN } from "@open-rgs/selectors";
import { stackyFill } from "@open-rgs/markov";
import { place, recipes } from "@open-rgs/recipes";
import { paytable, totalMultiplier, type Roles, type Win } from "@open-rgs/paytable";
import { evalLines, rowLines } from "@open-rgs/pay-lines";
import { countAnywhere } from "@open-rgs/pay-anywhere";
import {
  type Cell, type Coin, type JackpotTable, type RespinConfig,
  beginRespins, coin, emptyPositions, isCycleOver, mixedCoinSet,
  settleRespins, stepRespins,
} from "@open-rgs/holdwin";

// --- the host surface -------------------------------------------------------
// Mirrors @open-rgs/contract's MathHost / SimpleMath. Declared locally so the
// libraries stay decoupled from the server package; a real game imports them.

export interface MathHost {
  rng_next(): number;
  log_debug(message: string): void;
}

export interface Outcome {
  multiplier: number;
  ops: unknown[];
  type: string;
}

// --- symbols ----------------------------------------------------------------

export const SHAPE = rect(5, 3);

/** COIN is a scatter: it never joins a payline run, and a wild can never
 *  substitute for it. Both matter - a wild that manufactured coins would
 *  rewrite the feature trigger rate, which is the largest single term in this
 *  game's RTP. */
export const ROLES: Roles = { wilds: ["WILD"], scatters: ["COIN"] };

export const BASE_WEIGHTS = {
  LOW: 44, MID: 24, HI: 12, PREM: 7, WILD: 6, COIN: 7,
} as const;

/** 0.35 gives visible stacking without the board turning into solid blocks.
 *  Because transitions are built with `sticky`, changing this does NOT move
 *  symbol frequency - so it can be tuned for feel alone. */
export const STACKINESS = 0.35;

export const PAY = paytable({
  LOW: { 3: 0.17, 4: 0.7, 5: 2.8 },
  MID: { 3: 0.34, 4: 1.4, 5: 5.5 },
  HI: { 3: 0.7, 4: 2.8, 5: 11 },
  PREM: { 3: 1.4, 4: 4.5, 5: 20 },
  WILD: { 3: 2.2, 4: 9, 5: 40 },
});

export const LINES = rowLines(5, 3);

// --- the feature ------------------------------------------------------------

export const TRIGGER_COINS = 6;

export const JACKPOTS: JackpotTable = { MINI: 8, MINOR: 20, MAJOR: 60, GRAND: 400 };

export const RESPINS: RespinConfig = { respins: 3, fullBoardAward: "GRAND" };

/** What a landed coin is worth. Cash dominates; tiers are rare and carry the
 *  ladder. GRAND is deliberately not directly landable - it is reached by
 *  filling the board, which is what makes a nearly-full grid exciting. */
export const COINS = mixedCoinSet(
  [
    { item: coin(1), weight: 43 },
    { item: coin(2), weight: 27 },
    { item: coin(4), weight: 16 },
    { item: coin(8), weight: 8 },
    { item: coin(15), weight: 3 },
  ],
  { MINI: 5, MINOR: 1.6, MAJOR: 0.35 },
);

/** Chance an individual empty cell produces a coin on a respin. This is the
 *  single most sensitive number in the feature: it sets how long a cycle runs,
 *  and because a landing RESETS the respin counter, cycle length is highly
 *  non-linear in it. */
export const LAND_CHANCE = 0.1455;

// --- board generation -------------------------------------------------------

const reels = stackyFill(SHAPE, BASE_WEIGHTS, STACKINESS);

/** Coin-free reels, used underneath a tease so the placement lands on a board
 *  that cannot already be carrying coins. */
const reelsNoCoin = stackyFill(SHAPE, { ...BASE_WEIGHTS, COIN: 0 }, STACKINESS);

/**
 * Every board comes from exactly one named recipe.
 *
 * The two teases are REAL draws that go through the pay evaluator honestly -
 * they bias which boards appear, at a rate written down here, and never fake an
 * outcome. That makes "how often does a player see 5 coins and no sixth" a
 * number that can be measured and defended rather than an emergent accident.
 */
export const board = recipes<string>([
  { name: "base", p: 0.96, draw: reels },
  {
    name: "coin-tease",
    p: 0.03,
    draw: place(5, "COIN", randomN(5, cols([0, 1, 2, 3, 4])), reelsNoCoin),
  },
  {
    name: "prem-stack",
    p: 0.01,
    draw: place(3, "PREM", randomN(3, cols([0])), reels),
  },
]);

// --- the feature cycle ------------------------------------------------------

/** Coins landing on this respin: each empty cell independently. */
function landCoins(grid: Grid<Cell>, next: () => number): Array<readonly [{ col: number; row: number }, Coin]> {
  const out: Array<readonly [{ col: number; row: number }, Coin]> = [];
  for (const pos of emptyPositions(grid)) {
    if (next() < LAND_CHANCE) out.push([pos, COINS.pick(next())]);
  }
  return out;
}

/** Convert a triggering board into the feature's starting grid: coins become
 *  values, everything else becomes an empty cell to be respun. */
function toCoinGrid(grid: Grid<string>, next: () => number): Grid<Cell> {
  return {
    shape: grid.shape,
    cells: grid.cells.map((s) => (s === "COIN" ? COINS.pick(next()) : null)),
  };
}

/** Run the hold & win to completion. Returns the total as a multiple of bet. */
export function runFeature(triggerBoard: Grid<string>, next: () => number): {
  multiplier: number;
  spins: number;
  full: boolean;
} {
  let state = beginRespins(toCoinGrid(triggerBoard, next), RESPINS);
  // A landing resets the counter, so this loop is unbounded in principle. The
  // cap is what makes it bounded in practice - see MAX_WIN below.
  while (!isCycleOver(state)) {
    state = stepRespins(state, landCoins(state.grid, next), RESPINS);
  }
  return {
    multiplier: settleRespins(state, RESPINS, JACKPOTS),
    spins: state.spins,
    full: state.full,
  };
}

/** Hard ceiling on a round, as a multiple of bet. Every game needs one; this
 *  one needs it more than most, because the respin counter resets on a landing
 *  and a lucky cycle has no natural end. */
export const MAX_WIN = 5000;

// --- the math module --------------------------------------------------------

export default function createMath(host: MathHost) {
  return {
    kind: "simple" as const,
    name: "demo-holdwin",
    version: "1.0.0",
    rtp: 0.965,  // measured 96.49% +/- 0.56 over 20M spins

    play(): Outcome {
      const { grid, recipe } = board(host.rng_next);

      const lineWins: Win<string>[] = evalLines(grid, LINES, PAY, { roles: ROLES });
      let multiplier = totalMultiplier(lineWins);

      // Count the COIN SYMBOL. holdwin's `triggers()` works on a Grid<Cell>
      // where empty is null - casting a Grid<string> into it makes every cell
      // read as a coin, and the feature fires on literally every spin.
      const coins = countAnywhere(grid, "COIN");
      const feature = coins >= TRIGGER_COINS ? runFeature(grid, host.rng_next) : undefined;
      if (feature) multiplier += feature.multiplier;

      const capped = Math.min(multiplier, MAX_WIN);

      return {
        multiplier: capped,
        ops: [
          { kind: "spin", grid: grid.cells, recipe, coins },
          ...lineWins.map((w) => ({ kind: "line", ...w })),
          ...(feature
            ? [{ kind: "feature", spins: feature.spins, full: feature.full, won: feature.multiplier }]
            : []),
          ...(capped < multiplier ? [{ kind: "maxWin", uncapped: multiplier }] : []),
        ],
        type: capped > 0 ? "win" : "loss",
      };
    },
  };
}
