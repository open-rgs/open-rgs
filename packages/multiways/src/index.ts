// @open-rgs/multiways - each reel draws its own height, every spin.
//
// NAMING. "Multiways" throughout, deliberately. The popular variable-height
// mechanic is a registered trademark of another studio; this package implements
// the general idea under a neutral name and never uses theirs.
//
// THE MECHANIC. Instead of a fixed 5x3, each reel independently draws a height
// from a weighted set - say 2 to 7 - and the ways available that spin are the
// product of those heights. Six reels at 2..7 span 2^6 = 64 ways to
// 7^6 = 117,649.
//
// HOW LITTLE CODE THIS TAKES. A drawn shape IS the mechanic, and
// @open-rgs/grid has been shape-per-column since its first commit, so
// multiways needs no special grid, no special evaluator, and no changes
// anywhere downstream: @open-rgs/pay-ways already multiplies real column
// heights. That is the whole payoff of making shape a `number[]` rather than a
// width and a height - the decision cost one array then and buys this now.
//
// BALANCING. Reel heights are independent, so E[ways] is the product of the
// per-reel expected heights (see `expectedWays`). RTP scales with ways, so
// that number is the one to tune against - and it is arithmetic, not a
// simulation.

import { type Grid, type Shape, assertShape, fromColumns } from "@open-rgs/grid";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

/** Produces a grid from a stream of floats in [0, 1). */
export type Generator<S = string> = (next: () => number) => Grid<S>;

/** Weighted heights for one reel, e.g. `{ 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 }`. */
export type HeightSpec = Readonly<Record<number, number>>;

/** A per-reel height sampler. */
export interface Heights {
  readonly reels: number;
  /** Draw a shape - one height per reel, consuming one float each. */
  draw(next: () => number): Shape;
  /** Expected height of one reel. */
  expected(reel: number): number;
  /** Smallest and largest height a reel can draw. */
  range(reel: number): { min: number; max: number };
  /** Height distribution of one reel - needed to price a win analytically. */
  distribution(reel: number): Array<{ height: number; p: number }>;
}

function toSampler(spec: HeightSpec): Sampler<number> {
  const entries = Object.entries(spec).map(([h, weight]) => {
    const height = Number(h);
    if (!Number.isInteger(height) || height <= 0) {
      throw new Error(`multiways: reel height must be a positive integer, got '${h}'`);
    }
    return { item: height, weight };
  });
  if (entries.length === 0) throw new Error("multiways: a reel needs at least one possible height");
  return sampler(entries as unknown as WeightSpec<number>) as Sampler<number>;
}

/**
 * Build a height sampler.
 *
 * Pass one spec to use it for every reel, or one per reel when the outer reels
 * should behave differently from the middle - which is the usual shape, since a
 * tall first reel changes the feel of a game far more than a tall third one.
 */
export function heights(spec: HeightSpec | ReadonlyArray<HeightSpec>, reels?: number): Heights {
  const specs: HeightSpec[] = Array.isArray(spec)
    ? [...(spec as ReadonlyArray<HeightSpec>)]
    : Array.from({ length: reels ?? 0 }, () => spec as HeightSpec);

  if (specs.length === 0) {
    throw new Error("multiways: give a spec per reel, or one spec plus a reel count");
  }
  const samplers = specs.map(toSampler);

  return {
    reels: samplers.length,
    draw(next) {
      const shape = samplers.map((s) => s.pick(next()));
      assertShape(shape);
      return shape;
    },
    expected(reel) {
      const s = samplers[reel];
      if (!s) return 0;
      let n = 0;
      for (const { item, p } of s.distribution()) n += item * p;
      return n;
    },
    distribution(reel) {
      const s = samplers[reel];
      if (!s) return [];
      return s.distribution().map((d: { item: number; p: number }) => ({ height: d.item, p: d.p }));
    },
    range(reel) {
      const s = samplers[reel];
      if (!s) return { min: 0, max: 0 };
      let min = Infinity;
      let max = 0;
      for (let i = 0; i < s.items.length; i++) {
        if (s.weights[i]! <= 0) continue; // a zero-weight height can never be drawn
        const h = s.items[i]!;
        if (h < min) min = h;
        if (h > max) max = h;
      }
      return { min: Number.isFinite(min) ? min : 0, max };
    },
  };
}

/** Ways a shape offers - the product of its column heights. */
export function waysOf(shape: Shape): number {
  let n = 1;
  for (const h of shape) n *= h;
  return n;
}

/**
 * Expected ways per spin.
 *
 * Reel heights are drawn INDEPENDENTLY, so the expectation of the product is
 * the product of the expectations. That independence is load-bearing: correlate
 * the reels (a "all reels go tall together" feature, say) and this number stops
 * being right, because E[XY] != E[X]E[Y] once X and Y move together. Such a
 * feature belongs in its own recipe with its own measured contribution.
 */
export function expectedWays(h: Heights): number {
  let n = 1;
  for (let reel = 0; reel < h.reels; reel++) n *= h.expected(reel);
  return n;
}

/** Fewest ways the game can present. */
export function minWays(h: Heights): number {
  let n = 1;
  for (let reel = 0; reel < h.reels; reel++) n *= h.range(reel).min;
  return n;
}

/** Most ways the game can present - the number that ends up on the marketing. */
export function maxWays(h: Heights): number {
  let n = 1;
  for (let reel = 0; reel < h.reels; reel++) n *= h.range(reel).max;
  return n;
}

/**
 * A generator that draws a fresh shape each spin and fills it.
 *
 * Consumes one float per reel for the heights, then one per cell - so the draw
 * order is heights first, then symbols, and a seeded replay reproduces both.
 */
export function multiwaysFill<S>(h: Heights, symbols: Sampler<S>): Generator<S> {
  return (next) => {
    const shape = h.draw(next);
    const columns: S[][] = [];
    for (const height of shape) {
      const column: S[] = [];
      for (let row = 0; row < height; row++) column.push(symbols.pick(next()));
      columns.push(column);
    }
    return fromColumns(columns);
  };
}

/** Convenience: build the symbol sampler from a raw weight spec. */
export function multiwaysFillWeights<S>(h: Heights, spec: WeightSpec<S>): Generator<S> {
  return multiwaysFill(h, sampler(spec) as Sampler<S>);
}


// --- pricing a multiways game -----------------------------------------------
//
// THE TRAP. `expectedWays` is the BOARD's ways - the marketing number. It is
// NOT the multiplier a win receives, and rescaling a fixed-height paytable by
// E[ways] / fixedWays gets the game wrong.
//
// The reason is that a win of k columns carries a ways multiplier scaling as
// h^k, while the board carries h^reels. Only a paytable whose weight sits
// entirely on FULL-LENGTH runs scales with board ways; every shorter run scales
// slower, and short runs are where most of a paytable's expected value lives.
// Measured on a 5-reel game going from height 2 to height 4 - a 32x increase in
// board ways:
//
//     pays only 2-of-a-kind    2.25x
//     pays only 3-of-a-kind    4.50x
//     pays only 5-of-a-kind   32.00x   <- equals board ways exactly
//     a normal mixed paytable 23.31x
//
// So payout growth is bounded ABOVE by ways growth, and a naive rescale
// OVER-prices the game by however far the paytable's weight sits from the top.
// How far is a property of your paytable, not a constant - which is why this is
// computed rather than assumed.

/** Expected matching symbols on one reel, for a symbol with per-cell
 *  probability `p`. Simply `p * E[height]`. */
export function expectedMatches(h: Heights, reel: number, p: number): number {
  return p * h.expected(reel);
}

/** Probability a reel holds NO match - what ends a run.
 *
 *  Averaged over the reel's own height distribution, because a taller reel is
 *  less likely to come up empty. */
export function probNoMatch(h: Heights, reel: number, p: number): number {
  let acc = 0;
  for (const { height, p: ph } of h.distribution(reel)) acc += ph * Math.pow(1 - p, height);
  return acc;
}

/**
 * Exact expected payout per spin for one symbol, in bet multiples.
 *
 * The identity that makes this closed-form: a run's ways multiplier is the
 * product of per-column match counts, and a column with zero matches
 * contributes a factor of zero - so `m * 1(m >= 1)` is just `m`, and the "the
 * run had to reach here" condition folds into the expectation for free. Hence
 *
 *     E[payout] = SUM over k of  pay(k) * PROD(i<k) p*E[h_i] * P(no match on reel k)
 *
 * with the final term omitted for a run spanning every reel. Columns are
 * independent, which is what licenses the product - correlate the reels and
 * this stops being exact.
 */
export function expectedWaysPayout(
  h: Heights,
  p: number,
  pay: (columns: number) => number,
): number {
  let total = 0;
  let runProduct = 1;
  for (let k = 1; k <= h.reels; k++) {
    runProduct *= expectedMatches(h, k - 1, p);
    const stops = k < h.reels ? probNoMatch(h, k, p) : 1;
    total += pay(k) * runProduct * stops;
  }
  return total;
}
