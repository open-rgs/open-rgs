// @open-rgs/picks - the bonus round where the player chooses.
//
// Three shapes cover nearly all of them, and they differ only in what ends the
// round:
//
//   pick N of M          a fixed number of picks, then it stops
//   pick until a stop    keep going until a POOP / BOMB / COLLECT turns up
//   wheel                one draw from weighted segments
//
// The prizes are ordinary weighted sets, so the same `@open-rgs/weights`
// sampler that fills a reel fills a pick pool. Everything is a multiple of
// bet, and nothing here draws its own randomness: `next` is host.rng_next, so
// a recorded seed replays the round the player actually saw.
//
// WHY WITHOUT REPLACEMENT MATTERS. A pick round removes what it revealed, so
// the odds move as the player picks. Drawing with replacement instead is the
// classic mispricing: it looks the same on screen and pays a different
// expected value, and the gap grows with the number of picks.

import { type Sampler, type Weighted, type WeightSpec, sampler } from "@open-rgs/weights";

// --- the pool ----------------------------------------------------------------

/** What is left to reveal. Immutable: every reveal returns a new pool, so a
 *  round is a list of states rather than a mutated object. */
export interface Pool<T> {
  /** Items not yet revealed. */
  readonly remaining: readonly T[];
  /** Items revealed so far, oldest first. */
  readonly revealed: readonly T[];
}

/** A pool from an explicit list: twelve boxes, three of which hide a bomb. */
export function pool<T>(items: readonly T[]): Pool<T> {
  return { remaining: [...items], revealed: [] };
}

/** A pool built by drawing `size` items from a weighted set WITH replacement,
 *  then revealing them without. This is how "12 boxes, prizes weighted like
 *  this" is usually specified: the board is drawn once, the picking is then a
 *  question of what is left. */
export function pooledFrom<K extends string>(spec: Readonly<Record<K, number>>, size: number, next: () => number): Pool<K>;
export function pooledFrom<T>(spec: ReadonlyArray<Weighted<T>> | Sampler<T>, size: number, next: () => number): Pool<T>;
export function pooledFrom<T>(spec: WeightSpec<T> | Sampler<T>, size: number, next: () => number): Pool<T>;
export function pooledFrom<T>(spec: WeightSpec<T> | Sampler<T>, size: number, next: () => number): Pool<T> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`pooledFrom: size must be a positive integer, got ${size}`);
  }
  // A Sampler is accepted as-is; a raw spec is built into one. `in` on a union
  // of a record and an interface does not narrow usefully, so ask for the
  // method itself.
  const set: Sampler<T> = typeof (spec as Sampler<T>).pick === "function"
    ? (spec as Sampler<T>)
    : sampler(spec as WeightSpec<T>);
  const items: T[] = [];
  for (let i = 0; i < size; i++) items.push(set.pick(next()));
  return pool(items);
}

/** How many are left. */
export function remainingCount<T>(p: Pool<T>): number {
  return p.remaining.length;
}

/**
 * Reveal one item, uniformly from what is left.
 *
 * Uniform is deliberate: the weights already shaped the pool when it was
 * built, so weighting the reveal as well would apply them twice.
 */
export function reveal<T>(p: Pool<T>, next: () => number): { pool: Pool<T>; item: T | undefined } {
  if (p.remaining.length === 0) return { pool: p, item: undefined };
  const r = next();
  const i = Math.min(p.remaining.length - 1, Math.max(0, Math.floor(r * p.remaining.length)));
  const item = p.remaining[i]!;
  const remaining = [...p.remaining.slice(0, i), ...p.remaining.slice(i + 1)];
  return { pool: { remaining, revealed: [...p.revealed, item] }, item };
}

/**
 * Reveal `n` items.
 *
 * Asking for more than the pool holds reveals what is there: a bonus that
 * offers five picks on a four-box board is an authoring mistake, but throwing
 * mid-round would turn it into a failed spin for the player.
 */
export function pickN<T>(p: Pool<T>, n: number, next: () => number): { pool: Pool<T>; picked: T[] } {
  if (!Number.isInteger(n) || n < 0) throw new Error(`pickN: n must be a non-negative integer, got ${n}`);
  let cur = p;
  const picked: T[] = [];
  for (let i = 0; i < n && cur.remaining.length > 0; i++) {
    const step = reveal(cur, next);
    cur = step.pool;
    if (step.item !== undefined) picked.push(step.item);
  }
  return { pool: cur, picked };
}

export interface UntilResult<T> {
  readonly pool: Pool<T>;
  /** Everything revealed, in order, INCLUDING the stop that ended it. */
  readonly picked: readonly T[];
  /** The item that ended the round, if one did. */
  readonly stoppedBy: T | undefined;
  /** True when the pool ran out before a stop turned up. */
  readonly exhausted: boolean;
}

/**
 * Keep revealing until `isStop` says to stop.
 *
 * The genre's second shape: collect prizes until the bomb. The stop is
 * included in `picked`, because the player saw it and a report that hides it
 * cannot be reconciled against the screen. What a stop is worth is your
 * paytable's business; this only decides when the round ended.
 */
export function revealUntil<T>(
  p: Pool<T>,
  isStop: (item: T, index: number) => boolean,
  next: () => number,
  opts: { readonly maxPicks?: number } = {},
): UntilResult<T> {
  const maxPicks = opts.maxPicks ?? p.remaining.length;
  let cur = p;
  const picked: T[] = [];
  let stoppedBy: T | undefined;
  while (cur.remaining.length > 0 && picked.length < maxPicks) {
    const step = reveal(cur, next);
    cur = step.pool;
    if (step.item === undefined) break;
    picked.push(step.item);
    if (isStop(step.item, picked.length - 1)) { stoppedBy = step.item; break; }
  }
  return { pool: cur, picked, stoppedBy, exhausted: stoppedBy === undefined && cur.remaining.length === 0 };
}

// --- the wheel ---------------------------------------------------------------

/** A wheel is a weighted set with a name for the shape, because that is how a
 *  designer talks about it and because the segment list is what a client
 *  renders. */
export interface Wheel<T> {
  readonly segments: readonly T[];
  /** Chance of a segment, summed if it appears more than once. */
  probabilityOf(item: T): number;
  /** One spin. */
  spin(next: () => number): T;
}

/** Build a wheel from segments and weights. Equal weights make an evenly
 *  divided wheel, which is what a player assumes they are looking at.
 *
 *  Overloaded the way `sampler` is, so `wheel({ MINI: 50, GRAND: 5 })` gives a
 *  `Wheel<"MINI" | "GRAND">` and a typo in a segment name is a type error
 *  rather than a segment that never lands. */
export function wheel<K extends string>(spec: Readonly<Record<K, number>>): Wheel<K>;
export function wheel<T>(spec: ReadonlyArray<Weighted<T>>): Wheel<T>;
export function wheel<T>(spec: WeightSpec<T>): Wheel<T>;
export function wheel<T>(spec: WeightSpec<T>): Wheel<T> {
  const set = sampler(spec);
  return {
    segments: set.items,
    probabilityOf: (item) => set.probabilityOf(item),
    spin: (next) => {
      // `Sampler.pick` takes a float and this takes the generator, which is a
      // difference worth naming: the two read alike at the call site.
      if (typeof next !== "function") {
        throw new TypeError(
          "wheel.spin takes the generator (host.rng_next), not a float. " +
          "Sampler.pick(r) is the one that takes a number.",
        );
      }
      return set.pick(next());
    },
  };
}

/** Expected value of a wheel, given what each segment pays. The number to
 *  check a bonus against before it ships. */
export function wheelValue<T>(w: Wheel<T>, valueOf: (item: T) => number): number {
  let total = 0;
  for (const seg of new Set(w.segments)) total += w.probabilityOf(seg) * valueOf(seg);
  return total;
}

// --- pricing a pick round ----------------------------------------------------

/**
 * Expected total of picking `n` from a pool, given what each item pays.
 *
 * Exact rather than simulated: reveals are uniform without replacement, so
 * every item is equally likely to be among the first `n`, and the expectation
 * is the pool's mean times `n`. Worth having because it is the number a
 * designer tunes against, and because it makes the with-replacement mistake
 * visible: that version pays the same mean per pick but a different
 * distribution, and a bonus is judged on its distribution.
 */
export function expectedPickTotal<T>(p: Pool<T>, n: number, valueOf: (item: T) => number): number {
  const items = p.remaining;
  if (items.length === 0 || n <= 0) return 0;
  const take = Math.min(n, items.length);
  let sum = 0;
  for (const it of items) sum += valueOf(it);
  return (sum / items.length) * take;
}

/**
 * Expected number of picks before a stop, for a pool with `stops` stops in it.
 *
 * The classic "collect until the bomb" question. With `k` stops among `m`
 * items, the expected number of non-stop items revealed first is
 * `(m - k) / (k + 1)`, so the round runs that many prizes on average. A
 * designer moving the bomb count is moving this number, and it is easier to
 * read here than to discover in a simulation.
 */
export function expectedPicksBeforeStop(poolSize: number, stops: number): number {
  if (!Number.isInteger(poolSize) || poolSize <= 0) return 0;
  if (!Number.isInteger(stops) || stops <= 0) return poolSize;
  if (stops >= poolSize) return 0;
  return (poolSize - stops) / (stops + 1);
}
