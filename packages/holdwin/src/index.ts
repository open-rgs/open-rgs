// @open-rgs/holdwin - the hold-and-win (respin / lock-and-spin) genre, as
// separate composable pieces rather than one engine with flags.
//
// THE CYCLE. N+ coins on a base board trigger respins (classically 6 coins on
// a 5x3). Coins LOCK. Every new coin resets the respin counter. The round ends
// when respins run out or the grid fills - and filling the grid classically
// awards the GRAND.
//
// THE VOCABULARY. A coin is a value, and some coins do things to other coins.
// Written out as a table, every mechanic in the genre is the same shape:
//
//     effect = (source cells) -> (target cells) -> operation
//
//   collector  all coins  -> itself      -> absorb their values
//   payer      itself     -> all coins   -> add its value to each
//   multiplier itself     -> all coins   -> scale each
//   upgrader   itself     -> one coin    -> bump a jackpot tier
//   spawner    itself     -> empty cells -> create new coins
//
// So they are ONE mechanism with different selectors, not five features. Each
// is exported separately, each is independently testable, and a game composes
// the ones it wants. Adding "collect only from the same column" is a selector,
// not a new engine.
//
// Everything is bet-relative. Values are multiples of the bet, never currency:
// math is currency-blind, and the orchestrator multiplies at settle.

import { type Grid, type Pos, countWhere, positionsWhere, sizeOf, withAt } from "@open-rgs/grid";
import { type Selector, all, upTo } from "@open-rgs/selectors";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

/** The four fixed jackpot tiers, smallest first. Named because these exact
 *  four are the genre's convention and a player reads them as a ladder. */
export const TIERS = ["MINI", "MINOR", "MAJOR", "GRAND"] as const;
export type Tier = (typeof TIERS)[number];

/** A cell during the respin phase. `null` is an empty (still spinning) cell. */
export type Cell = Coin | null;

/** A locked coin. Either a plain cash value or a jackpot tier - a tier's value
 *  is looked up at settle, so an upgrade changes the tier rather than the
 *  number, and the ladder stays authoritative in one place. */
export interface Coin {
  /** Cash value as a multiple of bet. Ignored when `tier` is set. */
  readonly value: number;
  /** Jackpot tier, when this coin is a jackpot rather than a cash value. */
  readonly tier?: Tier;
}

/** Cash coin of a given bet-multiple. */
export function coin(value: number): Coin {
  if (!Number.isFinite(value) || value < 0) throw new Error(`coin: value must be a non-negative number, got ${value}`);
  return { value };
}

/** Jackpot coin of a given tier. */
export function jackpot(tier: Tier): Coin {
  return { value: 0, tier };
}

/** Bet-multiples for each tier. GRAND is normally worth an order of magnitude
 *  more than MAJOR - the ladder is what makes the tease work. */
export type JackpotTable = Readonly<Record<Tier, number>>;

/** What a coin is worth, resolving a tier through the table. */
export function valueOf(c: Coin, jp: JackpotTable): number {
  return c.tier ? jp[c.tier] : c.value;
}

/** Total value locked on the board. */
export function totalValue(grid: Grid<Cell>, jp: JackpotTable): number {
  let n = 0;
  for (const c of grid.cells) if (c) n += valueOf(c, jp);
  return n;
}

/** Cells holding a coin. */
export function coinPositions(grid: Grid<Cell>): Pos[] {
  return positionsWhere(grid, (c) => c !== null);
}

/** Cells still empty. */
export function emptyPositions(grid: Grid<Cell>): Pos[] {
  return positionsWhere(grid, (c) => c === null);
}

/** How many coins are locked. */
export function coinCount(grid: Grid<Cell>): number {
  return countWhere(grid, (c) => c !== null);
}

// --- trigger ----------------------------------------------------------------

/** Does a base board have enough coins to start the feature?
 *
 *  The classic is 6 on a 5x3, which is a deliberately awkward number: 6 of 15
 *  cells is uncommon enough to feel like an event, and low enough that seeing
 *  4 or 5 is a genuine tease rather than a fabricated one. */
export function triggers(grid: Grid<Cell>, minCoins: number): boolean {
  return coinCount(grid) >= minCoins;
}

/** Coins short of triggering - the number a tease is built around. Zero once
 *  the board has triggered. */
export function coinsShortOfTrigger(grid: Grid<Cell>, minCoins: number): number {
  return Math.max(0, minCoins - coinCount(grid));
}

// -. The respin cycle -------------------------------------------------------

export interface RespinConfig {
  /** Respins granted at trigger, and restored whenever a new coin lands.
   *  Three is the genre default. */
  readonly respins: number;
  /** Award this tier when every cell fills. Classically GRAND; set to
   *  undefined for games that do not pay a full-board bonus. */
  readonly fullBoardAward?: Tier;
}

export interface RespinState {
  readonly grid: Grid<Cell>;
  /** Respins left. 0 means the cycle is over. */
  readonly respinsLeft: number;
  /** Spins taken since the cycle began - for reporting, not for logic. */
  readonly spins: number;
  /** True once every cell holds a coin. */
  readonly full: boolean;
}

/** Begin a cycle from a triggering board. */
export function beginRespins(grid: Grid<Cell>, cfg: RespinConfig): RespinState {
  return {
    grid,
    respinsLeft: cfg.respins,
    spins: 0,
    full: coinCount(grid) === sizeOf(grid.shape),
  };
}

/**
 * Advance one respin.
 *
 * `landed` is what the empty cells produced this spin - a coin, or null where
 * nothing landed. Only empty cells are considered: locked coins never move,
 * which is the defining rule of the genre.
 *
 * The counter RESETS on any new coin, rather than decrementing. That single
 * rule is what makes the feature feel alive, and it is also what makes the
 * cycle length unbounded in principle - so a max-win cap is not optional.
 */
export function stepRespins(
  state: RespinState,
  landed: ReadonlyArray<readonly [Pos, Coin]>,
  cfg: RespinConfig,
): RespinState {
  if (state.respinsLeft <= 0) return state;

  // Locked coins never move - the defining rule of the genre - so a landing
  // on an occupied cell is discarded rather than overwriting.
  const onlyEmpty = landed.filter(([p]) => cellAt(state.grid, p) === null);

  const grid = withAt(state.grid, onlyEmpty.map(([p, c]) => [p, c as Cell] as const));
  const full = coinCount(grid) === sizeOf(grid.shape);
  return {
    grid,
    // Reset on a landing, otherwise burn one.
    respinsLeft: full ? 0 : onlyEmpty.length > 0 ? cfg.respins : state.respinsLeft - 1,
    spins: state.spins + 1,
    full,
  };
}

/** Cycle is over: out of respins, or the board filled. */
export function isCycleOver(state: RespinState): boolean {
  return state.respinsLeft <= 0 || state.full;
}

/** Total award for a finished cycle, as a multiple of bet, including the
 *  full-board tier when the grid filled. */
export function settleRespins(state: RespinState, cfg: RespinConfig, jp: JackpotTable): number {
  const base = totalValue(state.grid, jp);
  const bonus = state.full && cfg.fullBoardAward ? jp[cfg.fullBoardAward] : 0;
  return base + bonus;
}

function cellAt(grid: Grid<Cell>, p: Pos): Cell {
  const shape = grid.shape;
  if (p.col < 0 || p.col >= shape.length) return null;
  const h = shape[p.col]!;
  if (p.row < 0 || p.row >= h) return null;
  let start = 0;
  for (let c = 0; c < p.col; c++) start += shape[c]!;
  return grid.cells[start + p.row] ?? null;
}

// --- effects: the sub-recipes ----------------------------------------------
//
// Each takes the board and the acting coin's position, and returns a new
// board. All five are the same shape with different selectors, which is why
// they are separate exports rather than flags on one function.

/** An effect a special coin applies when it lands (or at settle, depending on
 *  the game's rules - the caller decides when to run it). */
export type Effect = (grid: Grid<Cell>, source: Pos, next: () => number) => Grid<Cell>;

/**
 * COLLECTOR - absorbs the value of every targeted coin into itself.
 *
 * Targets default to every other coin. Pass a narrower selector for the
 * variants: same-column collectors, collect-only-cash, and so on.
 *
 * Collected coins are EMPTIED rather than removed, because a cell that has
 * paid out must not become landable again - otherwise a long cycle can collect
 * the same cell repeatedly and the max win stops being bounded by the grid.
 */
export function collector(targets: Selector<Cell> = coinCells(), jp?: JackpotTable): Effect {
  return (grid, source, next) => {
    const picks = targets(grid, next).filter((p) => !samePosition(p, source) && cellAt(grid, p) !== null);
    let gained = 0;
    for (const p of picks) {
      const c = cellAt(grid, p)!;
      if (c.tier && !jp) {
        // A tier coin has no value without the ladder. Defaulting the table
        // to zeros would absorb a GRAND at nothing and empty its cell: the
        // player loses the jackpot, the round's max-win accounting loses it
        // too, and nothing says so. Refuse rather than invent a value.
        throw new Error(
          `collector: collecting a ${c.tier} coin needs the jackpot table  - ` +
          `call collector(targets, jackpots) so the tier can be valued`,
        );
      }
      gained += valueOf(c, jp ?? ZERO_JACKPOTS);
    }

    const me = cellAt(grid, source);
    if (me?.tier && !jp) {
      throw new Error(
        `collector: the collecting coin is a ${me.tier}  - pass the jackpot table so its own value is known`,
      );
    }
    const merged: Coin = { value: (me ? valueOf(me, jp ?? ZERO_JACKPOTS) : 0) + gained };
    return withAt(grid, [
      ...picks.map((p) => [p, EMPTIED] as const),
      [source, merged] as const,
    ]);
  };
}

/** PAYER / ADDER - adds this coin's value to each targeted coin. */
export function payer(amount: number, targets: Selector<Cell> = all<Cell>()): Effect {
  return (grid, source, next) => {
    const picks = targets(grid, next).filter((p) => !samePosition(p, source) && cellAt(grid, p) !== null);
    return withAt(grid, picks.map((p) => {
      const c = cellAt(grid, p)!;
      // A jackpot coin keeps its tier; cash is topped up. Adding to a tier
      // would make the ladder mean two different things.
      return [p, c.tier ? c : { value: c.value + amount }] as const;
    }));
  };
}

/** MULTIPLIER - scales each targeted coin. Tiers are left alone for the same
 *  reason as payer: a "2x GRAND" is not a rung on the ladder. */
export function multiplier(factor: number, targets: Selector<Cell> = all<Cell>()): Effect {
  if (!Number.isFinite(factor) || factor < 0) throw new Error(`multiplier: factor must be non-negative, got ${factor}`);
  return (grid, source, next) => {
    const picks = targets(grid, next).filter((p) => !samePosition(p, source) && cellAt(grid, p) !== null);
    return withAt(grid, picks.map((p) => {
      const c = cellAt(grid, p)!;
      return [p, c.tier ? c : { value: c.value * factor }] as const;
    }));
  };
}

export interface UpgraderOptions {
  /** Ladder values, so an upgrade can be checked against what it replaces.
   *  Without it a cash coin is left alone (see `cash`). */
  readonly jackpots?: JackpotTable;
  /** What to do with a plain cash coin.
   *
   *, `"promote"` (default): turn it into MINI. The genre convention, and the
   *    behaviour every existing game is priced against - which is why it stays
   *    the default. Note what it means though: a cash coin worth MORE than MINI
   *    is DOWNGRADED by its own upgrade, and the player watches it happen.
   *, `"promote-if-better"`: promote only when MINI is worth at least as much
   *    as the cash coin. Needs `jackpots` to compare. This is what most games
   *    mean by "upgrade".
   *, `"skip"`: leave cash coins alone; the upgrader only walks the ladder. */
  readonly cash?: "promote" | "promote-if-better" | "skip";
}

/** UPGRADER - bumps targeted coins one rung up the jackpot ladder.
 *
 *  GRAND is the top and stays put, rather than wrapping or overflowing into a
 *  fifth tier that has no name and no value.
 *
 *  A cash coin becomes MINI by default, which is the genre convention and can
 *  also be a DOWNGRADE - a 50x cash coin "upgraded" into a 10x MINI is worth
 *  less than it was. `cash: "promote-if-better"` is the version most games
 *  actually mean; see {@link UpgraderOptions.cash}. */
export function upgrader(
  targets: Selector<Cell> = upTo(1, all<Cell>()),
  opts: UpgraderOptions = {},
): Effect {
  const cashRule = opts.cash ?? "promote";
  if (cashRule === "promote-if-better" && !opts.jackpots) {
    throw new Error("upgrader: cash 'promote-if-better' needs the jackpot table to compare against");
  }
  return (grid, source, next) => {
    const picks = targets(grid, next).filter((p) => !samePosition(p, source) && cellAt(grid, p) !== null);
    const writes: Array<readonly [Pos, Cell]> = [];
    for (const p of picks) {
      const c = cellAt(grid, p)!;
      if (!c.tier) {
        if (cashRule === "skip") continue;
        if (cashRule === "promote-if-better" && opts.jackpots && opts.jackpots.MINI < c.value) continue;
        writes.push([p, jackpot(TIERS[0]!)] as const);
        continue;
      }
      const idx = TIERS.indexOf(c.tier);
      writes.push([p, jackpot(TIERS[Math.min(idx + 1, TIERS.length - 1)]!)] as const);
    }
    return withAt(grid, writes);
  };
}

/**
 * SPAWNER - creates new coins in empty cells.
 *
 * Spawning is the mechanic most able to run away: new coins reset the respin
 * counter, so a spawner that fires often makes cycles that never end. Coins
 * come from a weighted set so the value is priced, and the count is bounded by
 * how many cells are actually empty.
 */
export function spawner(count: number, from: Sampler<Coin>, where: Selector<Cell> = emptyCells()): Effect {
  return (grid, source, next) => {
    void source;
    const empties = where(grid, next).filter((p) => cellAt(grid, p) === null);
    const take = Math.min(count, empties.length);
    return withAt(grid, empties.slice(0, take).map((p) => [p, from.pick(next()) as Cell] as const));
  };
}

/** Selector for cells with no coin - what a spawner fills. */
export function emptyCells(): Selector<Cell> {
  return (grid) => emptyPositions(grid);
}

/** Selector for cells holding a coin. */
export function coinCells(): Selector<Cell> {
  return (grid) => coinPositions(grid);
}

/** Selector for coins of specific tiers - "upgrade only a MINI". */
export function tierCells(tiers: readonly Tier[]): Selector<Cell> {
  const want = new Set(tiers);
  return (grid) => positionsWhere(grid, (c) => c !== null && c.tier !== undefined && want.has(c.tier));
}

/** Selector for plain cash coins - "collect cash, leave jackpots". */
export function cashCells(): Selector<Cell> {
  return (grid) => positionsWhere(grid, (c) => c !== null && c.tier === undefined);
}

/** A coin whose value has been absorbed. It still occupies its cell, so the
 *  board can still fill, but it is worth nothing and cannot be collected
 *  twice. */
export const EMPTIED: Coin = { value: 0 };

const ZERO_JACKPOTS: JackpotTable = { MINI: 0, MINOR: 0, MAJOR: 0, GRAND: 0 };

function samePosition(a: Pos, b: Pos): boolean {
  return a.col === b.col && a.row === b.row;
}

/** Build a weighted coin set from bet-multiples, e.g.
 *  `coinSet({ 1: 50, 2: 30, 5: 15, 10: 5 })`. */
export function coinSet(spec: Readonly<Record<string, number>>): Sampler<Coin> {
  const entries = Object.entries(spec).map(([v, weight]) => ({ item: coin(Number(v)), weight }));
  return sampler(entries);
}

/** Build a weighted set mixing cash coins and jackpot tiers. */
export function mixedCoinSet(cash: WeightSpec<Coin>, tiers: Partial<Record<Tier, number>>): Sampler<Coin> {
  const base = sampler(cash);
  const entries = base.items.map((item, i) => ({ item, weight: base.weights[i]! }));
  for (const t of TIERS) {
    const w = tiers[t];
    if (w !== undefined) entries.push({ item: jackpot(t), weight: w });
  }
  return sampler(entries);
}

/** Selector helper: every coin except the acting one. */
export function otherCoins(source: Pos): Selector<Cell> {
  return (grid, next) => coinCells()(grid, next).filter((p) => !samePosition(p, source));
}

