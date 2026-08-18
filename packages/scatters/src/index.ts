// @open-rgs/scatters - spawn scatters as a declared EVENT, on top of a board
// that cannot grow them naturally.
//
// WHY THIS BEATS PUTTING SCATTERS IN THE SYMBOL WEIGHTS.
//
// With a natural scatter, the trigger rate is an emergent property of per-cell
// probability and grid size, and you tune it by guessing at a weight and
// re-simulating. The relationship is steep and non-obvious: on a 49-cell board
// a 6% scatter weight lands 4+ scatters 34% of the time. Getting a 1-in-200
// feature out of that is fiddly, and the number you finally ship is a
// consequence rather than a decision.
//
// Spawning inverts it. The board is drawn with the scatter at weight zero -
// it CANNOT appear - and then a declared distribution says how many to place:
//
//     count: { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 }
//
// Now the trigger rate IS the parameter. "Three scatters happen 0.45% of
// spins" is written down, readable, and directly tunable, and
// `probabilityOfAtLeast(3)` reports it without a simulation.
//
// The constraints below exist because real games have them: scatters usually
// land at most one per reel, often skip the outer reels, and must not eat a
// wild that the player can see is about to pay.

import {
  type Grid, type Pos, heightOf, indexOf, widthOf, withAt,
} from "@open-rgs/grid";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

/** Produces a grid from a stream of floats in [0, 1). */
export type Generator<S = string> = (next: () => number) => Grid<S>;

export interface SpawnConfig<S = string> {
  /** The scatter symbol to write. */
  readonly symbol: S;
  /** Weighted spawn count, e.g. `{ 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 }`.
   *  This IS the trigger rate - the whole reason to spawn rather than draw. */
  readonly count: Readonly<Record<number, number>>;
  /** Reels that may receive a scatter. Omit for all of them. */
  readonly reels?: readonly number[];
  /** At most one scatter per reel. Defaults to TRUE - the genre norm, and what
   *  makes the count distribution exactly controllable. */
  readonly onePerReel?: boolean;
  /** Only these symbols may be replaced. Omit to allow any. */
  readonly replaces?: readonly S[];
  /** These symbols are never replaced - a wild the player can see is about to
   *  pay, most often. Takes precedence over `replaces`. */
  readonly protects?: readonly S[];
}

/** What a spawn actually did. `wanted` and `spawned` differ only when the board
 *  could not host the draw; see {@link spawnOn}. */
export interface SpawnResult<S = string> {
  readonly grid: Grid<S>;
  /** Count drawn from the distribution. */
  readonly wanted: number;
  /** Count actually written. */
  readonly spawned: number;
  /** Cells written. */
  readonly positions: readonly number[];
}

/** Samplers built per config, not per spin.
 *
 *  `spawnOn` used to call `countSampler(cfg.count)` on every call - revalidating
 *  the distribution and rebuilding its cumulative table on the hot path, in a
 *  library whose own documentation tells you to build a sampler once at module
 *  scope. The config object is the natural key: a game builds one and reuses it,
 *  so the cache holds one entry per configured spawn.
 *
 *  Weak, so a config built per spin by a caller that insists on it is still
 *  collectable rather than a leak. */
const COUNT_SAMPLERS = new WeakMap<object, Sampler<number>>();

function countSamplerFor<S>(cfg: SpawnConfig<S>): Sampler<number> {
  const hit = COUNT_SAMPLERS.get(cfg as unknown as object);
  if (hit) return hit;
  const built = countSampler(cfg.count);
  COUNT_SAMPLERS.set(cfg as unknown as object, built);
  return built;
}

function countSampler(spec: Readonly<Record<number, number>>): Sampler<number> {
  const entries = Object.entries(spec).map(([n, weight]) => {
    const count = Number(n);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`scatters: spawn count must be a non-negative integer, got '${n}'`);
    }
    return { item: count, weight };
  });
  if (entries.length === 0) throw new Error("scatters: count distribution is empty");
  return sampler(entries as unknown as WeightSpec<number>) as Sampler<number>;
}

/**
 * Validate a config against a reel count.
 *
 * Catches the STRUCTURAL impossibility at build time: asking for 4 scatters,
 * one per reel, on a game whose `reels` list has three entries. That is an
 * authoring mistake, and left to run it would silently place three and quietly
 * halve the trigger rate you declared.
 *
 * It cannot catch the CONTENT-dependent case - a spin where every legal cell
 * happens to hold a protected symbol - because that depends on the board. See
 * {@link spawnOn} for how that is surfaced rather than hidden.
 */
export function assertFeasible<S>(cfg: SpawnConfig<S>, reelCount: number): void {
  const s = countSampler(cfg.count);
  const allowed = cfg.reels ? cfg.reels.filter((r) => r >= 0 && r < reelCount) : rangeOf(reelCount);
  if (allowed.length === 0) {
    throw new Error(`scatters: no reels are eligible (reels: [${(cfg.reels ?? []).join(",")}], grid has ${reelCount})`);
  }
  const onePerReel = cfg.onePerReel ?? true;
  let maxWanted = 0;
  for (let i = 0; i < s.items.length; i++) {
    if (s.weights[i]! > 0 && s.items[i]! > maxWanted) maxWanted = s.items[i]!;
  }
  if (onePerReel && maxWanted > allowed.length) {
    throw new Error(
      `scatters: count distribution can draw ${maxWanted} but only ${allowed.length} ` +
        `reels are eligible and onePerReel is set - that draw could never be honoured, ` +
        `so the declared trigger rate would be silently wrong`,
    );
  }
}

function rangeOf(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Cells a scatter may legally replace, grouped by reel. */
function legalByReel<S>(grid: Grid<S>, cfg: SpawnConfig<S>): Map<number, Pos[]> {
  const allowed = new Set(cfg.reels ?? rangeOf(widthOf(grid.shape)));
  const replaces = cfg.replaces ? new Set(cfg.replaces) : undefined;
  const protects = cfg.protects ? new Set(cfg.protects) : undefined;

  const out = new Map<number, Pos[]>();
  for (let col = 0; col < widthOf(grid.shape); col++) {
    if (!allowed.has(col)) continue;
    const cells: Pos[] = [];
    for (let row = 0; row < heightOf(grid.shape, col); row++) {
      const s = grid.cells[indexOf(grid.shape, col, row)]!;
      if (s === cfg.symbol) continue;               // already a scatter
      if (protects?.has(s)) continue;               // protected beats replaces
      if (replaces && !replaces.has(s)) continue;   // not on the allowlist
      cells.push({ col, row });
    }
    if (cells.length > 0) out.set(col, cells);
  }
  return out;
}

/** Partial Fisher-Yates: `count` items uniformly without replacement, one
 *  float each. */
function drawSome<T>(pool: readonly T[], count: number, next: () => number): T[] {
  const rest = pool.slice();
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const span = rest.length - i;
    let j = i + Math.floor(next() * span);
    if (j >= rest.length) j = rest.length - 1;
    const picked = rest[j]!;
    rest[j] = rest[i]!;
    rest[i] = picked;
    out.push(picked);
  }
  return out;
}

/**
 * Spawn scatters onto a board.
 *
 * Draw order, which a seeded replay depends on: one float for the count, then
 * one per reel chosen, then one per cell within a reel. With `onePerReel` off,
 * it is one float per cell chosen.
 *
 * WHEN THE BOARD CANNOT HOST THE DRAW. If protections or exclusions leave fewer
 * legal cells than the count drawn, this places what it can and reports both
 * numbers rather than throwing or silently under-delivering. Throwing would
 * crash a legitimate spin; silence would break the declared trigger rate with
 * nothing to notice it. Reporting lets a simulator measure how often it
 * happens - and if it happens at all often, the `protects` set is too wide.
 */
export function spawnOn<S>(grid: Grid<S>, cfg: SpawnConfig<S>, next: () => number): SpawnResult<S> {
  const wanted = countSamplerFor(cfg).pick(next());
  if (wanted === 0) return { grid, wanted: 0, spawned: 0, positions: [] };

  const byReel = legalByReel(grid, cfg);
  const onePerReel = cfg.onePerReel ?? true;

  let chosen: Pos[];
  if (onePerReel) {
    const reels = [...byReel.keys()].sort((a, b) => a - b);
    const take = Math.min(wanted, reels.length);
    chosen = drawSome(reels, take, next).map((reel) => {
      const cells = byReel.get(reel)!;
      return drawSome(cells, 1, next)[0]!;
    });
  } else {
    const all = [...byReel.keys()].sort((a, b) => a - b).flatMap((r) => byReel.get(r)!);
    chosen = drawSome(all, Math.min(wanted, all.length), next);
  }

  const out = withAt(grid, chosen.map((p) => [p, cfg.symbol] as const));
  return {
    grid: out,
    wanted,
    spawned: chosen.length,
    positions: chosen.map((p) => indexOf(grid.shape, p.col, p.row)),
  };
}

/** Wrap a generator so every board it produces gets its scatters spawned.
 *  The base generator should carry the scatter at weight ZERO - the point is
 *  that it cannot appear naturally. */
export function withScatters<S>(base: Generator<S>, cfg: SpawnConfig<S>): Generator<S> {
  return (next) => spawnOn(base(next), cfg, next).grid;
}

// --- reading the trigger rate ----------------------------------------------
//
// These are the numbers the whole approach exists to make readable. None of
// them needs a simulation.

/** Exact probability of drawing exactly `n`. */
export function probabilityOfCount<S>(cfg: SpawnConfig<S>, n: number): number {
  return countSampler(cfg.count).probabilityOf(n);
}

/** Exact probability of drawing `n` or more - the trigger rate for a feature
 *  that needs `n` scatters. */
export function probabilityOfAtLeast<S>(cfg: SpawnConfig<S>, n: number): number {
  const s = countSampler(cfg.count);
  let p = 0;
  for (const { item, p: prob } of s.distribution()) if (item >= n) p += prob;
  return p;
}

/** Expected scatters per spin. */
export function expectedCount<S>(cfg: SpawnConfig<S>): number {
  const s = countSampler(cfg.count);
  let n = 0;
  for (const { item, p } of s.distribution()) n += item * p;
  return n;
}

/** "1 in N spins" for a feature needing `n` scatters. Infinity when it can
 *  never trigger, which is worth seeing rather than dividing by zero. */
export function oneInFor<S>(cfg: SpawnConfig<S>, n: number): number {
  const p = probabilityOfAtLeast(cfg, n);
  return p > 0 ? 1 / p : Infinity;
}
