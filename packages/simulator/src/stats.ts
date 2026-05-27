// Streaming-friendly stat helpers for big simulator runs.

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population stddev (divides by N, not N-1). Simulator samples are full
 *  populations for the purposes of math review. */
export function stdDev(xs: readonly number[], m?: number): number {
  if (xs.length === 0) return 0;
  const mu = m ?? mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - mu;
    s += d * d;
  }
  return Math.sqrt(s / xs.length);
}

/** Percentile by nearest-rank on a *sorted* array. Pass an already-sorted
 *  array to avoid the O(n log n) per call. */
export function percentileSorted(sortedXs: readonly number[], p: number): number {
  if (sortedXs.length === 0) return 0;
  const idx = Math.min(
    sortedXs.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedXs.length) - 1),
  );
  return sortedXs[idx]!;
}
