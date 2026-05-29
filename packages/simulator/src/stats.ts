// Streaming-friendly stat helpers for big simulator runs.

/** Kahan (compensated) summation — bounds the rounding error that naive
 *  left-to-right addition accumulates over the 10^8+ samples a real RTP
 *  certification run produces. (L2) */
function kahanSum(xs: readonly number[]): number {
  let sum = 0;
  let c = 0; // running compensation for lost low-order bits
  for (const x of xs) {
    const y = x - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return sum;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return kahanSum(xs) / xs.length;
}

/** Population stddev (divides by N, not N-1). Simulator samples are full
 *  populations for the purposes of math review. */
export function stdDev(xs: readonly number[], m?: number): number {
  if (xs.length === 0) return 0;
  const mu = m ?? mean(xs);
  let sum = 0;
  let c = 0;
  for (const x of xs) {
    const d = x - mu;
    const y = d * d - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return Math.sqrt(sum / xs.length);
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
