// Tiny deterministic PRNGs. Re-exported as @open-rgs/simulator/rng so
// integrators can use the same one to seed math at load time + the
// simulator's own choices, getting reproducible reports end-to-end.

/** mulberry32 — 32-bit state, period 2^32, decent statistical quality
 *  for non-cryptographic use. ~3 lines of code; you can paste it into
 *  a CI script if you want to verify a recorded report later. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
