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

import { type Grid, type Pos, type Shape, assertShape, countWhere, positionsWhere, sizeOf, withAt } from "@open-rgs/grid";
import { type Selector, all, randomN, upTo } from "@open-rgs/selectors";
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
  /** Face down. The cell is taken and the respin counter reset like any other
   *  coin, but the value is not decided yet: {@link revealMystery} writes the
   *  real coins in. Pricing one before it turns over is an error, not a zero,
   *  which is what stops a collector from harvesting the board for nothing. */
  readonly mystery?: true;
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

/** A face-down coin. Locks its cell and resets the counter like any other;
 *  worth nothing until {@link revealMystery} turns it over. */
export function mystery(): Coin {
  return { value: 0, mystery: true };
}

/** Is this cell holding a coin that has not turned over yet? */
export function isMystery(c: Cell): boolean {
  return c !== null && c.mystery === true;
}

/** Cells still face down. */
export function mysteryPositions(grid: Grid<Cell>): Pos[] {
  return positionsWhere(grid, (c) => isMystery(c));
}

/** Selector for the face-down cells, for an effect that targets them. */
export function mysteryCells(): Selector<Cell> {
  return (grid) => mysteryPositions(grid);
}

export interface RevealOptions {
  /** `true` (the default) turns every face-down cell over to the SAME coin,
   *  which is the genre convention. It pays the same on average as drawing one
   *  per cell and swings far harder, because the cells are then perfectly
   *  correlated: with four hidden cells the standard deviation roughly doubles.
   *
   *  `false` draws independently per cell. */
  readonly shared?: boolean;
}

/**
 * Turn every face-down coin over.
 *
 * Run this before anything reads values - a collector, a multiplier, the
 * settle. Reading an unrevealed coin throws (see {@link valueOf}), so the
 * ordering mistake is an error rather than a board harvested at zero.
 */
export function revealMystery(
  grid: Grid<Cell>,
  from: Sampler<Coin>,
  next: () => number,
  opts: RevealOptions = {},
): Grid<Cell> {
  const hidden = mysteryPositions(grid);
  if (hidden.length === 0) return grid;
  const shared = opts.shared ?? true;
  if (shared) {
    const value = from.pick(next());
    return withAt(grid, hidden.map((p) => [p, value as Cell] as const));
  }
  return withAt(grid, hidden.map((p) => [p, from.pick(next()) as Cell] as const));
}

/** Bet-multiples for each tier. GRAND is normally worth an order of magnitude
 *  more than MAJOR - the ladder is what makes the tease work. */
export type JackpotTable = Readonly<Record<Tier, number>>;

/** What a coin is worth, resolving a tier through the table.
 *
 *  A face-down coin has no value yet, so asking for one is a bug in the order
 *  of operations rather than a zero: reveal first (see {@link revealMystery}),
 *  then collect, multiply and settle. */
export function valueOf(c: Coin, jp: JackpotTable): number {
  if (c.mystery) {
    throw new Error(
      "valueOf: this coin is still face down. Call revealMystery(grid, coins, next) " +
      "before anything reads values - a collector or a settle running first would " +
      "price the whole board at zero.",
    );
  }
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

// --- drawing a respin's landings --------------------------------------------
//
// `stepRespins` applies landings; these draw them, in the two shapes the genre
// actually uses. They are here because every hold-and-win writes one of them,
// and because which one you pick is a real decision about the game rather than
// a detail of your loop.

/**
 * One independent trial per empty cell: the usual shape.
 *
 * Landings scale with how empty the board is, so a nearly full board rarely
 * takes another coin and the cycle ends on its own. `chance` is that per-cell
 * probability, and it is the dial for cycle length; the sampler is the dial for
 * what a cycle pays. Put {@link mystery} in the sampler to have face-down coins
 * land at their own weight.
 */
export function landCoins(
  grid: Grid<Cell>,
  chance: number,
  from: Sampler<Coin>,
  next: () => number,
): Array<readonly [Pos, Coin]> {
  if (!Number.isFinite(chance) || chance < 0 || chance > 1) {
    throw new Error(`landCoins: chance must be a probability in [0, 1], got ${chance}`);
  }
  const out: Array<readonly [Pos, Coin]> = [];
  for (const pos of emptyPositions(grid)) {
    if (next() < chance) out.push([pos, from.pick(next())]);
  }
  return out;
}

/**
 * A drawn COUNT, placed in empty cells at random: the other shape.
 *
 * The rate does not fall as the board fills, so cycles run longer and far more
 * of them reach a full board. That moves the full-board award, which is usually
 * the largest single term in the feature's RTP, so the two shapes are different
 * games rather than different spellings.
 *
 * `count` is a fixed number or a weighted set of counts. Asking for more than
 * the board can hold places what fits, because the alternative is a spin that
 * throws for being lucky.
 */
export function landCount(
  grid: Grid<Cell>,
  count: number | Sampler<number>,
  from: Sampler<Coin>,
  next: () => number,
): Array<readonly [Pos, Coin]> {
  const wanted = typeof count === "number" ? count : count.pick(next());
  if (!Number.isInteger(wanted) || wanted < 0) {
    throw new Error(
      `landCount: count must be a non-negative integer, got ${JSON.stringify(wanted)}. ` +
      `A weighted count is a countSet({ 1: 50, 2: 30 }), not a coinSet - a coin set ` +
      `draws coins, a count set draws how many.`,
    );
  }
  const empties = emptyPositions(grid);
  const take = Math.min(wanted, empties.length);
  if (take === 0) return [];
  const chosen = randomN<Cell>(take, emptyCells())(grid, next);
  return chosen.map((pos) => [pos, from.pick(next())] as const);
}

// --- the cycle, as one call --------------------------------------------------

export interface RunRespinsOptions {
  /** Runs after each respin, with the state as it now stands. Return a new
   *  state to change it: this is where an expansion, an awarded spin, or an
   *  effect belongs. Return nothing to leave it alone. */
  readonly onSpin?: (state: RespinState, next: () => number) => RespinState | void;
  /** Hard stop, so a bug in `land` cannot hang a round. A cycle is unbounded in
   *  principle - every landing resets the counter - and this is not the payout
   *  cap, which is the orchestrator's job. Default 1000. */
  readonly maxSpins?: number;
}

/**
 * Run a cycle to its end.
 *
 * The loop every hold-and-win writes: spin, apply the landings, stop when the
 * counter runs out or the board fills.
 */
export function runRespins(
  start: RespinState,
  cfg: RespinConfig,
  land: (grid: Grid<Cell>, next: () => number) => ReadonlyArray<readonly [Pos, Coin]>,
  next: () => number,
  opts: RunRespinsOptions = {},
): RespinState {
  const maxSpins = opts.maxSpins ?? 1000;
  let state = start;
  while (!isCycleOver(state) && state.spins < maxSpins) {
    state = stepRespins(state, land(state.grid, next), cfg);
    const changed = opts.onSpin?.(state, next);
    if (changed) state = changed;
  }
  return state;
}

// --- multipliers that belong to the BOARD -----------------------------------
//
// Two different mechanics share the word. A multiplier COIN scales other coins
// and is an effect (see `multiplier` below). A multiplier printed on a CELL
// belongs to the board: whatever finishes in that cell is worth more, and a
// second multiplier landing there raises the factor rather than replacing the
// coin. Cells keep their factor across an expansion, so this is keyed by
// position rather than by flat index.

/** Factors by cell. Build with {@link addCellMultiplier}. */
export type CellMultipliers = ReadonlyMap<string, number>;

const cellKey = (p: Pos): string => `${p.col}:${p.row}`;

/** An empty factor map. */
export function noCellMultipliers(): CellMultipliers {
  return new Map();
}

/** How a second multiplier landing on an occupied cell combines with the
 *  first. Games ship all three; the choice moves the top of the distribution a
 *  long way, so it is spelled out rather than assumed. */
export type MultiplierStack = "add" | "multiply" | "replace";

/** Put a factor on a cell, combining with whatever is already there. */
export function addCellMultiplier(
  m: CellMultipliers,
  pos: Pos,
  factor: number,
  stack: MultiplierStack = "add",
): CellMultipliers {
  if (!Number.isFinite(factor) || factor < 0) {
    throw new Error(`addCellMultiplier: factor must be a non-negative number, got ${factor}`);
  }
  const out = new Map(m);
  const key = cellKey(pos);
  const current = out.get(key);
  if (current === undefined || stack === "replace") out.set(key, factor);
  else if (stack === "add") out.set(key, current + factor);
  else out.set(key, current * factor);
  return out;
}

/** The factor on a cell, or 1 where none was placed. */
export function cellFactorAt(m: CellMultipliers, pos: Pos): number {
  return m.get(cellKey(pos)) ?? 1;
}

/** Every cell carrying a factor, for rendering and for tests. */
export function cellMultiplierPositions(m: CellMultipliers): Array<{ pos: Pos; factor: number }> {
  return [...m].map(([key, factor]) => {
    const [col, row] = key.split(":");
    return { pos: { col: Number(col), row: Number(row) }, factor };
  });
}

/** Board value with each coin scaled by its cell's factor. */
export function totalValueWithCells(grid: Grid<Cell>, jp: JackpotTable, m: CellMultipliers): number {
  let n = 0;
  let i = 0;
  for (let col = 0; col < grid.shape.length; col++) {
    const h = grid.shape[col]!;
    for (let row = 0; row < h; row++, i++) {
      const c = grid.cells[i];
      if (c) n += valueOf(c, jp) * cellFactorAt(m, { col, row });
    }
  }
  return n;
}

// --- extra respins ----------------------------------------------------------

/**
 * Award respins on top of the counter, for the "+1 spin" symbol.
 *
 * Distinct from a landing, which RESETS the counter to the configured number.
 * An award adds to whatever is left, so it is worth most late in a cycle -
 * which is the tease the symbol exists to create.
 */
export function awardRespins(state: RespinState, extra: number): RespinState {
  if (!Number.isInteger(extra) || extra < 0) {
    throw new Error(`awardRespins: extra must be a non-negative integer, got ${extra}`);
  }
  if (state.full) return state;   // a full board has already ended the cycle
  return { ...state, respinsLeft: state.respinsLeft + extra };
}

// --- a board that grows mid-cycle -------------------------------------------

export interface ExpandOptions {
  /** Where the new cells appear in a column that got taller. `"bottom"` (the
   *  default) keeps existing coins at their row index and opens rows beneath
   *  them; `"top"` pushes them down so the new rows open above. */
  readonly anchor?: "top" | "bottom";
}

/**
 * Grow the board without disturbing what is locked on it.
 *
 * Games unlock rows or whole reels partway through a cycle, usually on a coin
 * count. The new cells are empty, so they immediately become landing targets,
 * and `full` is recomputed against the bigger board - which is why an
 * expansion pushes the full-board award further away and lengthens the cycle.
 * A shape that would shrink a column is refused: coins never move, so there is
 * nowhere for the ones in the lost rows to go.
 */
export function expandBoard(state: RespinState, shape: Shape, opts: ExpandOptions = {}): RespinState {
  assertShape(shape);
  const from = state.grid.shape;
  if (shape.length < from.length) {
    throw new Error(`expandBoard: cannot drop columns (${from.length} -> ${shape.length})`);
  }
  for (let col = 0; col < from.length; col++) {
    if (shape[col]! < from[col]!) {
      throw new Error(`expandBoard: column ${col} would shrink (${from[col]} -> ${shape[col]}), and locked coins cannot move`);
    }
  }
  const anchor = opts.anchor ?? "bottom";
  const cells: Cell[] = [];
  for (let col = 0; col < shape.length; col++) {
    const height = shape[col]!;
    const was = col < from.length ? from[col]! : 0;
    const offset = anchor === "top" ? height - was : 0;
    for (let row = 0; row < height; row++) {
      const old = row - offset;
      cells.push(old >= 0 && old < was ? cellAt(state.grid, { col, row: old }) : null);
    }
  }
  const grid: Grid<Cell> = { shape, cells };
  return { ...state, grid, full: coinCount(grid) === sizeOf(shape) };
}

/** Cycle is over: out of respins, or the board filled. */
export function isCycleOver(state: RespinState): boolean {
  return state.respinsLeft <= 0 || state.full;
}

export interface SettleOptions {
  /** Factors printed on cells (see {@link addCellMultiplier}). Applied to the
   *  coin that finished in each cell, once, at settle. */
  readonly cellMultipliers?: CellMultipliers;
  /** Whether the full-board award is scaled by the factor on its own cell.
   *  Default false: the award belongs to the board, not to a cell. */
  readonly multiplyFullBoardAward?: boolean;
}

/** Total award for a finished cycle, as a multiple of bet, including the
 *  full-board tier when the grid filled. */
export function settleRespins(
  state: RespinState,
  cfg: RespinConfig,
  jp: JackpotTable,
  opts: SettleOptions = {},
): number {
  const m = opts.cellMultipliers;
  const base = m ? totalValueWithCells(state.grid, jp, m) : totalValue(state.grid, jp);
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

/** Weighted counts, for {@link landCount}: `countSet({ 1: 50, 2: 30, 3: 20 })`
 *  reads "one coin half the time, two coins a third of the time". Written as a
 *  record like {@link coinSet}, because otherwise the two look interchangeable
 *  and are not: a coin set draws coins, a count set draws how many. */
export function countSet(spec: Readonly<Record<string, number>>): Sampler<number> {
  const entries = Object.entries(spec).map(([n, weight]) => {
    const count = Number(n);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`countSet: count must be a non-negative integer, got '${n}'`);
    }
    return { item: count, weight };
  });
  if (entries.length === 0) throw new Error("countSet: needs at least one count");
  return sampler(entries);
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

