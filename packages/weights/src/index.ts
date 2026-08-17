// @open-rgs/weights - exact weighted sampling.
//
// This package exists because of what it makes READABLE, not what it makes
// fast. A reel strip encodes probability indirectly: you move symbols around an
// array to shift odds, frequency is tangled up with adjacency, and answering
// "how often does WILD land?" means counting entries and reasoning about window
// size. A weighted set answers it with `probabilityOf(WILD)`.
//
// That readability is the whole balancing story. RTP is a sum over outcomes of
// probability x payout; when probability is a number you can read, retuning a
// game is turning a dial, and the simulator's measured RTP has an exact
// analytic value to be checked against rather than merely compared with the
// last run.
//
// Draws take an `r` in [0, 1) supplied by the caller - always
// `host.rng_next()` in real math. Nothing here generates randomness; that would
// bypass the auditable RNG seam.

/** One weighted entry. Weights are relative and need not sum to anything. */
export interface Weighted<T> {
  readonly item: T;
  readonly weight: number;
}

/** A weighted set with its probabilities precomputed. Build once at module
 *  scope, draw per spin - the cumulative table is what makes a draw O(log n)
 *  and the probabilities readable. */
export interface Sampler<T> {
  readonly items: readonly T[];
  readonly weights: readonly number[];
  /** Sum of weights. Probability of entry i is `weights[i] / total`. */
  readonly total: number;
  /** Draw for `r` in [0, 1). Deterministic: the same r always gives the same
   *  item, which is what makes a seeded replay reproduce. */
  pick(r: number): T;
  /** Exact probability of an item in [0, 1]. Sums the entries if the same item
   *  appears more than once. Returns 0 for an item that is not present. */
  probabilityOf(item: T): number;
  /** Every item with its exact probability - the table you read when balancing,
   *  and the input to an analytic RTP. */
  distribution(): Array<{ item: T; p: number }>;
}

/** Accepts either explicit entries or a plain `{ item: weight }` record, which
 *  is how a paytable is usually written. */
export type WeightSpec<T> = ReadonlyArray<Weighted<T>> | Readonly<Record<string, number>>;

function normalize<T>(spec: WeightSpec<T>): Array<Weighted<T>> {
  if (Array.isArray(spec)) return spec.slice() as Array<Weighted<T>>;
  return Object.entries(spec as Record<string, number>).map(([item, weight]) => ({
    item: item as unknown as T,
    weight,
  }));
}

/**
 * Build a sampler.
 *
 * Rejects anything that would make a draw ill-defined - a negative weight, a
 * non-finite weight, an empty set, or a total of zero. These are authoring
 * mistakes that otherwise surface as a silently skewed RTP thousands of spins
 * later, so they fail at build time instead.
 *
 * Zero-weight entries ARE allowed: a symbol that exists in the game but cannot
 * be drawn in this mode is a real thing (a scatter excluded from a respin set),
 * and `probabilityOf` correctly reports 0.
 */
// The first two overloads give real inference at call sites - `sampler({LOW:60})`
// types as Sampler<"LOW">, not Sampler<unknown>. The third accepts the union, so
// helpers that take a WeightSpec can still pass it through.
export function sampler<K extends string>(spec: Readonly<Record<K, number>>): Sampler<K>;
export function sampler<T>(spec: ReadonlyArray<Weighted<T>>): Sampler<T>;
export function sampler<T>(spec: WeightSpec<T>): Sampler<T>;
export function sampler<T>(spec: WeightSpec<T>): Sampler<T> {
  const entries = normalize(spec);
  if (entries.length === 0) throw new Error("sampler: needs at least one entry");

  const items: T[] = [];
  const weights: number[] = [];
  const cumulative: number[] = [];
  let total = 0;

  for (let i = 0; i < entries.length; i++) {
    const { item, weight } = entries[i]!;
    if (!Number.isFinite(weight)) throw new Error(`sampler: entry ${i} has a non-finite weight (${weight})`);
    if (weight < 0) throw new Error(`sampler: entry ${i} has a negative weight (${weight})`);
    total += weight;
    items.push(item);
    weights.push(weight);
    cumulative.push(total);
  }

  if (total <= 0) throw new Error("sampler: total weight must be greater than zero");

  return {
    items,
    weights,
    total,
    pick(r: number): T {
      // Clamping rather than throwing: an rng returning exactly 1 (or a hair
      // under, then rounding up through the multiply) must not fail a spin.
      const x = r <= 0 ? 0 : r >= 1 ? total : r * total;
      // Binary search for the first cumulative bound strictly greater than x.
      // Zero-weight entries leave the cumulative flat, so the search skips them.
      let lo = 0;
      let hi = cumulative.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid]! <= x) lo = mid + 1;
        else hi = mid;
      }
      // At the very top of the range (x === total) the search lands on the last
      // entry, which may be a zero-weight one - and a zero-weight entry must be
      // unreachable at EVERY r, not merely almost every r. Walk back to the last
      // drawable entry. `total > 0` guarantees one exists.
      if (weights[lo]! === 0) {
        for (let i = weights.length - 1; i >= 0; i--) if (weights[i]! > 0) { lo = i; break; }
      }
      return items[lo]!;
    },
    probabilityOf(item: T): number {
      let w = 0;
      for (let i = 0; i < items.length; i++) if (items[i] === item) w += weights[i]!;
      return w / total;
    },
    distribution(): Array<{ item: T; p: number }> {
      return items.map((item, i) => ({ item, p: weights[i]! / total }));
    },
  };
}

/**
 * Draw `n` DISTINCT items, weight-proportionally, without replacement.
 *
 * This is what a placement directive needs - "put 3 high symbols on the grid"
 * wants three different symbols, not the same one three times. Consumes one `r`
 * per item drawn, so a caller threading `host.rng_next` gets a reproducible
 * sequence.
 *
 * Throws when `n` exceeds the number of entries that can actually be drawn
 * (zero-weight entries do not count), because silently returning fewer than
 * asked would corrupt a placement the caller has already priced into its RTP.
 */
export function pickDistinct<T>(s: Sampler<T>, n: number, next: () => number): T[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`pickDistinct: n must be a non-negative integer, got ${n}`);
  const drawable = s.weights.reduce((acc, w) => acc + (w > 0 ? 1 : 0), 0);
  if (n > drawable) {
    throw new Error(`pickDistinct: asked for ${n} distinct items but only ${drawable} have a non-zero weight`);
  }

  const remainingItems = s.items.slice();
  const remainingWeights = s.weights.slice();
  let total = s.total;
  const out: T[] = [];

  for (let k = 0; k < n; k++) {
    const x = next() * total;
    let acc = 0;
    let chosen = -1;
    for (let i = 0; i < remainingItems.length; i++) {
      const w = remainingWeights[i]!;
      if (w <= 0) continue;
      acc += w;
      if (x < acc) { chosen = i; break; }
    }
    // Guard the float edge: if rounding walked past every bound, take the last
    // drawable entry rather than failing the spin.
    if (chosen < 0) {
      for (let i = remainingItems.length - 1; i >= 0; i--) if (remainingWeights[i]! > 0) { chosen = i; break; }
    }
    out.push(remainingItems[chosen]!);
    total -= remainingWeights[chosen]!;
    remainingWeights[chosen] = 0;
  }
  return out;
}

/** Rescale a weight spec so its probabilities are unchanged but the total is
 *  exactly 1 - useful when writing a distribution into a report or comparing
 *  two sets authored at different scales. */
export function normalized<T>(spec: WeightSpec<T>): Array<{ item: T; p: number }> {
  return sampler(spec).distribution();
}
