// @open-rgs/markov - stacking, without giving up frequency control.
//
// THE PROBLEM. Independent per-cell draws (@open-rgs/fill) give you exact,
// readable symbol frequency but no adjacency: three HIGH in a column happens
// only at p^3, so reels never feel like reels. Strips give you adjacency but
// tangle it with frequency, which is why they are miserable to rebalance.
//
// THE FIX. Draw each column as a Markov chain: the symbol at row r depends on
// the symbol at row r-1. High P(same | same) produces natural stacks.
//
// Why this is not a trade-off. Build the transitions with `sticky(base, s)`:
//
//     P(j | i) = s * [i = j] + (1 - s) * base[j]
//
// and the chain's stationary distribution is EXACTLY `base`, for every s < 1.
// (pi[j] = s*pi[j] + (1-s)*base[j]  =>  pi[j] = base[j].) So `s` moves how
// clumpy the reels look and moves symbol frequency not at all. That is the
// property strips cannot give you: one knob for feel, another for maths, and
// they do not interact.
//
// `stationary()` computes the marginals for hand-written transition tables too,
// so the frequency you balance against stays a number you can read.

import { type Grid, type Shape, assertShape, fromColumns, widthOf } from "@open-rgs/grid";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

/** Per-symbol transition table: what may follow each symbol, as a weighted set. */
export type Transitions<S extends string> = Readonly<Record<S, Sampler<S>>>;

/** Produces a grid from a stream of floats in [0, 1). */
export type Generator<S = string> = (next: () => number) => Grid<S>;

/**
 * Transitions with a tunable stickiness that leaves frequency untouched.
 *
 * `stickiness` is the probability of simply repeating the previous symbol;
 * otherwise the next symbol is drawn from `base`. 0 reproduces independent
 * draws exactly; 0.9 gives long stacks. Values at or above 1 are rejected -
 * the chain would never leave its first symbol, every column would be a solid
 * block, and the stationary distribution would be undefined.
 */
export function sticky<K extends string>(
  base: Readonly<Record<K, number>>,
  stickiness: number,
): Transitions<K> {
  if (!Number.isFinite(stickiness) || stickiness < 0 || stickiness >= 1) {
    throw new Error(`sticky: stickiness must be in [0, 1), got ${stickiness}`);
  }
  const keys = Object.keys(base) as K[];
  if (keys.length === 0) throw new Error("sticky: base distribution needs at least one symbol");

  const total = keys.reduce((n, k) => n + base[k], 0);
  if (!(total > 0)) throw new Error("sticky: base weights must total more than zero");

  const out = {} as Record<K, Sampler<K>>;
  for (const from of keys) {
    const spec = {} as Record<K, number>;
    for (const to of keys) {
      // Scaled by `total` so the caller's weights need not be normalised.
      spec[to] = (1 - stickiness) * base[to] + (to === from ? stickiness * total : 0);
    }
    out[from] = sampler(spec) as Sampler<K>;
  }
  return out;
}

/** Build transitions from raw weight specs, for tables written by hand. */
export function transitions<K extends string>(
  spec: Readonly<Record<K, WeightSpec<K>>>,
): Transitions<K> {
  const out = {} as Record<K, Sampler<K>>;
  for (const from of Object.keys(spec) as K[]) out[from] = sampler(spec[from]) as Sampler<K>;
  return out;
}

/**
 * Long-run symbol frequency of a transition table - the number you balance
 * against, and the analytic value a measured frequency should match.
 *
 * Power iteration run TO A TOLERANCE rather than a fixed step count, because
 * convergence rate is the chain's second eigenvalue - which for `sticky`
 * transitions is the stickiness itself. A sticky-0.99 chain moves 0.99x closer
 * per step, so a fixed 512 steps leaves an error near 5e-3: fine at a glance,
 * and wrong by three orders of magnitude for a table you are balancing against.
 * Slow-mixing chains simply take more steps.
 *
 * Converges for any chain that can reach every symbol. A chain with an
 * unreachable symbol still converges; that symbol gets probability 0, which is
 * the honest answer.
 */
export function stationary<K extends string>(
  t: Transitions<K>,
  opts: { tolerance?: number; maxIterations?: number } = {},
): Record<K, number> {
  const tolerance = opts.tolerance ?? 1e-13;
  const maxIterations = opts.maxIterations ?? 2_000_000;
  const keys = Object.keys(t) as K[];
  if (keys.length === 0) throw new Error("stationary: transitions are empty");

  let pi = {} as Record<K, number>;
  for (const k of keys) pi[k] = 1 / keys.length;

  for (let step = 0; step < maxIterations; step++) {
    const nextPi = {} as Record<K, number>;
    for (const k of keys) nextPi[k] = 0;
    for (const from of keys) {
      const p = pi[from];
      if (p === 0) continue;
      const s = t[from];
      for (let i = 0; i < s.items.length; i++) {
        const to = s.items[i]!;
        if (to in nextPi) nextPi[to] += p * (s.weights[i]! / s.total);
      }
    }
    // Renormalise against drift from repeated float multiplication.
    let sum = 0;
    for (const k of keys) sum += nextPi[k];
    if (sum > 0) for (const k of keys) nextPi[k] /= sum;

    let delta = 0;
    for (const k of keys) delta += Math.abs(nextPi[k] - pi[k]);
    pi = nextPi;
    if (delta < tolerance) break;
  }
  return pi;
}

/**
 * Draw every column as an independent Markov chain, top to bottom.
 *
 * The first cell of each column comes from `start` (pass the base distribution
 * to start the chain already at its stationary state, so the top row is not
 * biased); each subsequent cell is drawn from the previous symbol's row of the
 * transition table.
 *
 * Columns are independent of one another - vertical stacking is what reels
 * have, horizontal correlation is not.
 */
export function markovFill<K extends string>(
  shape: Shape,
  start: Sampler<K>,
  t: Transitions<K>,
): Generator<K> {
  assertShape(shape);
  return (next) => {
    const columns: K[][] = [];
    for (let c = 0; c < widthOf(shape); c++) {
      const height = shape[c]!;
      const column: K[] = [];
      let prev = start.pick(next());
      column.push(prev);
      for (let r = 1; r < height; r++) {
        const row = t[prev];
        if (!row) throw new Error(`markovFill: no transition row for symbol '${String(prev)}'`);
        prev = row.pick(next());
        column.push(prev);
      }
      columns.push(column);
    }
    return fromColumns(columns);
  };
}

/** The common case in one call: a base distribution plus a stickiness knob.
 *  The chain starts at its stationary state, so the top row is unbiased. */
export function stackyFill<K extends string>(
  shape: Shape,
  base: Readonly<Record<K, number>>,
  stickiness: number,
): Generator<K> {
  const t = sticky(base, stickiness);
  return markovFill(shape, sampler(base) as Sampler<K>, t);
}

/**
 * Expected run length of a symbol under `sticky` transitions.
 *
 * A geometric distribution with continuation probability
 * `q = s + (1 - s) * base[symbol]`, so the mean run is `1 / (1 - q)`. Exposed
 * because "how tall do my stacks look?" is the question `stickiness` is
 * actually tuned against, and guessing at it from spin footage is slow.
 */
export function meanRunLength<K extends string>(
  base: Readonly<Record<K, number>>,
  stickiness: number,
  symbol: K,
): number {
  const total = Object.values(base).reduce((n: number, w) => n + (w as number), 0);
  const p = (base[symbol] ?? 0) / total;
  const q = stickiness + (1 - stickiness) * p;
  return q >= 1 ? Infinity : 1 / (1 - q);
}
