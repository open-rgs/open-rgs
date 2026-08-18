// @open-rgs/strips - the classic reel: a fixed sequence of symbols, a stop
// drawn per spin, and the window the player sees.
//
// WHY THIS EXISTS ALONGSIDE @open-rgs/weights. The rest of these libraries
// prefer weighted sets, because a weight is a probability you can read and a
// strip is one you have to count for. That preference is real and it is
// documented (spec 10), but strips are not going away and pretending otherwise
// helps nobody:
//
//   - A port of an existing cabinet game HAS strips, and reproducing its math
//     means reproducing them, not re-deriving equivalent weights.
//   - Some jurisdictions and some labs ask for the strip listing itself.
//   - Adjacency is a strip's whole point: what can appear ABOVE what is fixed
//     by the sequence, so stacks and near-misses are properties of the reel
//     rather than something a per-cell draw has to be talked into.
//
// So: strips are supported, honestly, with the counting tools that make their
// probabilities as readable as a weighted set's. If you are starting a new
// game and none of the three reasons applies, use @open-rgs/weights.
//
// One stop per reel is drawn from `next`, and the window wraps, because a reel
// is a loop.

import { type Grid, type Shape } from "@open-rgs/grid";

/** One reel: the symbols in order, top to bottom, wrapping at the end. */
export type Strip<S = string> = readonly S[];

/** A reel set: one strip per column. */
export type Strips<S = string> = ReadonlyArray<Strip<S>>;

/** Where each reel stopped: the index of the symbol at the TOP of the window. */
export type Stops = readonly number[];

/** Reject a strip set that cannot produce a board. */
export function assertStrips<S>(strips: Strips<S>, shape: Shape): void {
  if (strips.length === 0) throw new Error("strips: needs at least one reel");
  if (strips.length !== shape.length) {
    throw new Error(`strips: ${strips.length} reels for a ${shape.length}-column shape`);
  }
  for (let i = 0; i < strips.length; i++) {
    const strip = strips[i]!;
    if (strip.length === 0) throw new Error(`strips: reel ${i} is empty`);
    if (strip.length < shape[i]!) {
      throw new Error(
        `strips: reel ${i} has ${strip.length} symbols but the window shows ${shape[i]}. ` +
        `A window taller than its reel would show the same symbol twice.`,
      );
    }
  }
}

/** Symbol at a position on a reel, wrapping. Negative indices wrap too. */
export function symbolAt<S>(strip: Strip<S>, index: number): S {
  const n = strip.length;
  return strip[((index % n) + n) % n]!;
}

/** The window a stop shows: `height` symbols starting at `stop`. */
export function windowAt<S>(strip: Strip<S>, stop: number, height: number): S[] {
  const out: S[] = [];
  for (let row = 0; row < height; row++) out.push(symbolAt(strip, stop + row));
  return out;
}

/** Draw one stop per reel, uniformly. One float per reel, in reel order, so a
 *  seeded replay reproduces the same stops. */
export function drawStops<S>(strips: Strips<S>, next: () => number): number[] {
  return strips.map((strip) => {
    const r = next();
    const i = Math.floor(r * strip.length);
    return Math.min(strip.length - 1, Math.max(0, i));
  });
}

/** Build the board those stops show. */
export function boardFrom<S>(strips: Strips<S>, shape: Shape, stops: Stops): Grid<S> {
  assertStrips(strips, shape);
  if (stops.length !== strips.length) {
    throw new Error(`boardFrom: ${stops.length} stops for ${strips.length} reels`);
  }
  const cells: S[] = [];
  for (let col = 0; col < strips.length; col++) {
    cells.push(...windowAt(strips[col]!, stops[col]!, shape[col]!));
  }
  return { shape, cells };
}

/** Spin: draw the stops, then build the board. Returns both, because a strip
 *  game's replay is its stops and a report that keeps only the board has
 *  thrown away the smaller, more useful record. */
export function spinStrips<S>(
  strips: Strips<S>,
  shape: Shape,
  next: () => number,
): { grid: Grid<S>; stops: number[] } {
  assertStrips(strips, shape);
  const stops = drawStops(strips, next);
  return { grid: boardFrom(strips, shape, stops), stops };
}

// --- reading a strip's probabilities -----------------------------------------
//
// The counting a weighted set gives you for free. Every function here is exact
// rather than simulated, because a strip is a finite object and its answers
// are arithmetic.

/** How often a symbol appears on a reel. */
export function countOn<S>(strip: Strip<S>, symbol: S): number {
  let n = 0;
  for (const s of strip) if (s === symbol) n++;
  return n;
}

/** Chance a given ROW of the window shows a symbol: its count over the strip
 *  length, because stops are uniform. Same for every row, which is what makes
 *  a strip's per-cell probability easy and its ADJACENCY the interesting part. */
export function cellProbability<S>(strip: Strip<S>, symbol: S): number {
  return countOn(strip, symbol) / strip.length;
}

/** Chance a reel's window shows at least one of a symbol.
 *
 *  Not `height * cellProbability`: a stacked symbol appears in several rows of
 *  the SAME window, so multiplying overcounts exactly where a strip game puts
 *  its stacks. Counted over the stops instead, which is exact. */
export function windowProbability<S>(strip: Strip<S>, symbol: S, height: number): number {
  let hits = 0;
  for (let stop = 0; stop < strip.length; stop++) {
    if (windowAt(strip, stop, height).includes(symbol)) hits++;
  }
  return hits / strip.length;
}

/** Expected number of a symbol in a reel's window. `height * cellProbability`,
 *  which IS exact for a count (linearity of expectation), unlike the
 *  at-least-one figure above. */
export function expectedInWindow<S>(strip: Strip<S>, symbol: S, height: number): number {
  return height * cellProbability(strip, symbol);
}

/** Longest run of a symbol on the reel, counting the wrap. The number that
 *  decides how tall a stack can be. */
export function longestRun<S>(strip: Strip<S>, symbol: S): number {
  const n = strip.length;
  if (countOn(strip, symbol) === n) return n;
  let best = 0;
  let run = 0;
  for (let i = 0; i < n * 2; i++) {
    if (symbolAt(strip, i) === symbol) { run++; best = Math.max(best, run); }
    else run = 0;
  }
  return Math.min(best, n);
}

/** Distribution of how many of a symbol a window shows: index is the count. */
export function windowCountDistribution<S>(strip: Strip<S>, symbol: S, height: number): number[] {
  const counts: number[] = [];
  for (let stop = 0; stop < strip.length; stop++) {
    const n = windowAt(strip, stop, height).filter((s) => s === symbol).length;
    counts[n] = (counts[n] ?? 0) + 1;
  }
  const out: number[] = [];
  for (let i = 0; i <= height; i++) out.push((counts[i] ?? 0) / strip.length);
  return out;
}

/** Build a strip from a symbol listing, e.g. `stripOf({ LOW: 12, HIGH: 4 })`,
 *  shuffled deterministically from `next`.
 *
 *  For a NEW game this is a weighted set with extra steps, and the honest
 *  advice is to use one. It is here for the case where a specification names
 *  strip contents but not their order. */
export function stripOf<S extends string>(counts: Readonly<Record<S, number>>, next: () => number): S[] {
  const out: S[] = [];
  for (const [symbol, n] of Object.entries(counts) as Array<[S, number]>) {
    if (!Number.isInteger(n) || n < 0) throw new Error(`stripOf: '${symbol}' must appear a non-negative whole number of times, got ${n}`);
    for (let i = 0; i < n; i++) out.push(symbol);
  }
  if (out.length === 0) throw new Error("stripOf: a strip needs at least one symbol");
  // Fisher-Yates, one float per swap.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(next() * (i + 1)));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
