// @open-rgs/paytable - what a symbol is worth, and what kind of symbol it is.
//
// Every evaluator (lines, ways, anywhere, cluster) needs the same two answers:
// "how much does N of this pay?" and "is this a wild / a scatter?". Keeping
// them here means a symbol means the SAME THING in all four. When each
// evaluator carried its own notion of a wild, a game using two of them could
// disagree with itself about whether the wild substitutes for the scatter -
// and the two RTPs would quietly differ.
//
// Payouts are multiples of the bet. Math is currency-blind.

/** `{ HIGH: { 3: 5, 4: 20, 5: 100 } }` - counts that pay, and by how much.
 *  Counts with no entry pay nothing; there is no interpolation, because a
 *  paytable with a gap is an authoring mistake rather than a curve. */
export type PaytableSpec = Readonly<Record<string, Readonly<Record<number, number>>>>;

/** Which symbols behave specially. */
export interface Roles<S = string> {
  /** Substitute for any symbol except the scatters. */
  readonly wilds?: readonly S[];
  /** Paid on total count regardless of position, and never substituted for -
   *  otherwise a wild would manufacture free feature triggers. */
  readonly scatters?: readonly S[];
}

export interface Paytable<S = string> {
  /** Multiple of bet for `count` of `symbol`. 0 when that count does not pay. */
  pay(symbol: S, count: number): number;
  /** Smallest count that pays anything, or 0 if the symbol never pays. */
  minCount(symbol: S): number;
  /** Largest count with an entry, or 0. */
  maxCount(symbol: S): number;
  /** Every symbol with at least one payout. */
  readonly symbols: readonly S[];
  /** Best payout available for a symbol, at any count. Used to rank which of
   *  two competing interpretations of a run is worth more. */
  best(symbol: S): number;
}

/**
 * Build a paytable.
 *
 * Rejects a non-positive count and a negative payout at build time. A `0` count
 * entry is meaningless and a negative payout would make a "win" reduce the
 * round - both are authoring slips that otherwise surface as a wrong RTP.
 *
 * A payout of exactly 0 IS allowed: declaring `{ 2: 0 }` documents that two of
 * a kind is a real outcome worth nothing, which reads better than omitting it.
 */
export interface PaytableOptions {
  /** Allow a symbol's paying counts to skip a value (3 and 5 pay, 4 does not).
   *
   *  Off by default, and the default is the point. Evaluators look up the EXACT
   *  run length, so a gap does not fall back to the next paying count below it:
   *  it pays zero. The board that pays nothing is the LONGER one - four of a
   *  kind on a table that jumps 3 to 5 - which is the player's better board and
   *  the one nobody tests. It reads as an authoring slip in every real
   *  paytable, so it fails here, at build, rather than on that spin. */
  readonly allowGaps?: boolean;
}

export function paytable<S extends string>(spec: PaytableSpec, opts: PaytableOptions = {}): Paytable<S> {
  const table = new Map<string, Map<number, number>>();
  for (const [symbol, counts] of Object.entries(spec)) {
    const inner = new Map<number, number>();
    for (const [rawCount, payout] of Object.entries(counts)) {
      const count = Number(rawCount);
      if (!Number.isInteger(count) || count <= 0) {
        throw new Error(`paytable: '${symbol}' has a non-positive count (${rawCount})`);
      }
      if (!Number.isFinite(payout) || payout < 0) {
        throw new Error(`paytable: '${symbol}' at ${count} has an invalid payout (${payout})`);
      }
      inner.set(count, payout);
    }
    if (!opts.allowGaps) {
      const paying = [...inner].filter(([, v]) => v > 0).map(([k]) => k).sort((a, b) => a - b);
      const lowest = paying[0];
      const highest = paying[paying.length - 1];
      if (lowest !== undefined && highest !== undefined) {
        for (let n = lowest; n <= highest; n++) {
          if (!inner.has(n)) {
            throw new Error(
              `paytable: '${symbol}' pays at ${lowest} and ${highest} but has no entry for ${n}. ` +
              `Evaluators look up the exact run length, so ${n} of a kind would pay NOTHING while ` +
              `${lowest} pays. Add the entry (0 is fine - it documents the intent), or pass ` +
              `{ allowGaps: true } if this really is what the game does.`,
            );
          }
        }
      }
    }
    table.set(symbol, inner);
  }

  const symbols = [...table.keys()] as S[];

  return {
    symbols,
    pay(symbol, count) {
      return table.get(symbol as string)?.get(count) ?? 0;
    },
    minCount(symbol) {
      const inner = table.get(symbol as string);
      if (!inner || inner.size === 0) return 0;
      let min = Infinity;
      for (const [count, payout] of inner) if (payout > 0 && count < min) min = count;
      return Number.isFinite(min) ? min : 0;
    },
    maxCount(symbol) {
      const inner = table.get(symbol as string);
      if (!inner || inner.size === 0) return 0;
      let max = 0;
      for (const count of inner.keys()) if (count > max) max = count;
      return max;
    },
    best(symbol) {
      const inner = table.get(symbol as string);
      if (!inner) return 0;
      let best = 0;
      for (const payout of inner.values()) if (payout > best) best = payout;
      return best;
    },
  };
}

/** Is this symbol a wild? */
export function isWild<S>(symbol: S, roles: Roles<S>): boolean {
  return roles.wilds?.includes(symbol) ?? false;
}

/** Is this symbol a scatter? */
export function isScatter<S>(symbol: S, roles: Roles<S>): boolean {
  return roles.scatters?.includes(symbol) ?? false;
}

/**
 * Can `candidate` stand in for `target` in a run?
 *
 * True when they are equal, or when `candidate` is a wild and `target` is not a
 * scatter. That exception is the important one: a wild that substituted for the
 * scatter would manufacture free feature triggers, and the feature's frequency -
 * usually the single largest term in a game's RTP - would be wrong.
 */
export function substitutes<S>(candidate: S, target: S, roles: Roles<S>): boolean {
  if (candidate === target) return true;
  if (isScatter(target, roles)) return false;
  return isWild(candidate, roles);
}

/** A single win, however it was found. Every evaluator returns these, so a
 *  game can concatenate results from lines and scatters and total them once. */
export interface Win<S = string> {
  readonly symbol: S;
  /** Symbols in the winning run / cluster / count. */
  readonly count: number;
  /** Multiple of bet. */
  readonly multiplier: number;
  /** Which cells paid, as flat grid indices - enough for a client to
   *  highlight them without re-deriving the geometry. */
  readonly positions: readonly number[];
  /** Payline index, for line wins. */
  readonly line?: number;
  /** Number of ways, for ways wins. The multiplier already includes it. */
  readonly ways?: number;
}

/** Sum of every win's multiplier - what a round pays before any cap. */
export function totalMultiplier<S>(wins: readonly Win<S>[]): number {
  let n = 0;
  for (const w of wins) n += w.multiplier;
  return n;
}

/**
 * Expand size BANDS into the exact-count entries a paytable holds.
 *
 * Cluster games pay by range - "5 to 8 symbols pay 1x, 9 to 11 pay 5x, 12 or
 * more pay 20x" - while a paytable stores exact counts so there is never any
 * interpolation to reason about. This bridges the two:
 *
 *     bands({ A: [[5, 1], [9, 5], [12, 20]] }, 30)
 *     -> { A: { 5:1, 6:1, 7:1, 8:1, 9:5, 10:5, 11:5, 12:20, ... 30:20 } }
 *
 * `maxCount` is normally the grid size, since that is the largest cluster the
 * board can physically hold. Writing the bands out by hand works too - this is
 * ergonomics, not a different model.
 */
export function bands(
  spec: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>,
  maxCount: number,
): PaytableSpec {
  if (!Number.isInteger(maxCount) || maxCount <= 0) {
    throw new Error(`bands: maxCount must be a positive integer, got ${maxCount}`);
  }
  const out: Record<string, Record<number, number>> = {};
  for (const [symbol, list] of Object.entries(spec)) {
    if (list.length === 0) throw new Error(`bands: '${symbol}' has no bands`);
    const sorted = [...list].sort((a, b) => a[0] - b[0]);
    for (const [from] of sorted) {
      if (!Number.isInteger(from) || from <= 0) {
        throw new Error(`bands: '${symbol}' has a non-positive band start (${from})`);
      }
      if (from > maxCount) {
        // A band that can never be reached is an authoring slip - usually a
        // paytable copied from a bigger grid - and would silently pay nothing.
        throw new Error(`bands: '${symbol}' band starts at ${from}, above maxCount ${maxCount}`);
      }
    }
    const inner: Record<number, number> = {};
    for (let i = 0; i < sorted.length; i++) {
      const [from, payout] = sorted[i]!;
      const to = i + 1 < sorted.length ? sorted[i + 1]![0] - 1 : maxCount;
      for (let n = from; n <= to; n++) inner[n] = payout;
    }
    out[symbol] = inner;
  }
  return out;
}
