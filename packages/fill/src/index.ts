// @open-rgs/fill - weighted grid generation. The direct replacement for a
// reel strip.
//
// A strip encodes two things at once, tangled together: how OFTEN a symbol
// appears, and what it appears NEXT TO. Retuning frequency means re-authoring
// positions, and the two properties fight each other.
//
// This package takes the first one and makes it a number you set. Adjacency is
// deliberately NOT here - it belongs to @open-rgs/markov, which layers on top.
// Splitting them is the point: most balancing work is frequency work, and it
// should not require thinking about neighbours.
//
// Every generator is `(next) => Grid`. `next` supplies floats in [0, 1) and is
// always `host.rng_next` in real math. Generators never own randomness.

import { type Grid, type Shape, assertShape, makeGrid, widthOf } from "@open-rgs/grid";
import { type Sampler, type WeightSpec, sampler } from "@open-rgs/weights";

/** Produces a grid from a stream of floats. */
export type Generator<S = string> = (next: () => number) => Grid<S>;

/** Every cell drawn independently from one weighted set.
 *
 *  The exact symbol distribution is `set.distribution()` - readable, and the
 *  analytic input to an RTP calculation. That is the whole argument over a
 *  strip. */
export function fill<S>(shape: Shape, set: Sampler<S>): Generator<S> {
  assertShape(shape);
  return (next) => makeGrid(shape, () => set.pick(next()));
}

/** Per-column weighted sets - the classic way to differentiate reels, e.g. a
 *  wild that can only land on the middle three.
 *
 *  Requires one set per column. A short list is an authoring mistake that would
 *  otherwise show up as an undefined symbol mid-spin, so it throws at build
 *  time. */
export function fillPerColumn<S>(shape: Shape, sets: ReadonlyArray<Sampler<S>>): Generator<S> {
  assertShape(shape);
  const width = widthOf(shape);
  if (sets.length !== width) {
    throw new Error(`fillPerColumn: shape has ${width} columns but ${sets.length} weighted sets were given`);
  }
  return (next) => makeGrid(shape, ({ col }) => sets[col]!.pick(next()));
}

/** Convenience: build the sets from raw weight specs rather than samplers. */
export function fillWeights<S>(shape: Shape, spec: WeightSpec<S>): Generator<S> {
  return fill(shape, sampler(spec) as Sampler<S>);
}

/** Convenience: per-column, from raw specs. */
export function fillWeightsPerColumn<S>(shape: Shape, specs: ReadonlyArray<WeightSpec<S>>): Generator<S> {
  return fillPerColumn(shape, specs.map((s) => sampler(s) as Sampler<S>));
}

/** A grid of one symbol. Useful as a base a placement directive writes over,
 *  and as a fixture. Consumes no randomness. */
export function constant<S>(shape: Shape, symbol: S): Generator<S> {
  assertShape(shape);
  return () => makeGrid(shape, () => symbol);
}

/**
 * Exact probability that a given cell holds `symbol` under a generator built by
 * {@link fill} or {@link fillPerColumn}.
 *
 * Exposed because it is the number balancing actually runs on, and because a
 * measured Monte-Carlo frequency needs an analytic value to be checked against
 * rather than merely compared with the previous run.
 */
export function cellProbability<S>(sets: ReadonlyArray<Sampler<S>>, col: number, symbol: S): number {
  const set = sets[col];
  return set ? set.probabilityOf(symbol) : 0;
}

/**
 * Exact expected count of `symbol` across the whole grid.
 *
 * Cells are independent under these generators, so expectation is just the sum
 * of per-cell probabilities - which makes "how many scatters per spin on
 * average" an arithmetic question rather than a simulation one.
 */
export function expectedCount<S>(
  shape: Shape,
  sets: ReadonlyArray<Sampler<S>>,
  symbol: S,
): number {
  let n = 0;
  for (let c = 0; c < widthOf(shape); c++) {
    const set = sets[c];
    if (set) n += set.probabilityOf(symbol) * shape[c]!;
  }
  return n;
}
