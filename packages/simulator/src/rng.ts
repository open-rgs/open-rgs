// Tiny deterministic PRNG for the SIMULATOR ONLY — reproducible RTP runs
// and the simulator's own strategy/tie-break choices.
//
// ⚠️  NOT for production. mulberry32 has 32-bit state (period 2^32 — a few
// hours of spins at this project's throughput targets, after which the
// stream repeats), is fully determined by its seed, and is trivially
// predictable from a handful of outputs. Routing it into a production
// `loadLuaMath({ rng })` would make real-money outcomes predictable.
// Production REQUIRES a certified CSPRNG (see Spec 03 / audit C5). To make
// that hard to get wrong, the returned function is tagged
// `__insecureSimulatorRng` and `loadLuaMath` refuses it under
// NODE_ENV=production.

/** A seeded PRNG function, tagged as simulator-only so the math loader can
 *  reject it in production. */
export interface SeededRng {
  (): number;
  /** Marks this as a non-cryptographic simulator PRNG. loadLuaMath throws
   *  if it sees this in production (unless allowInsecureRng). */
  readonly __insecureSimulatorRng?: true;
}

/** mulberry32 — 32-bit state, period 2^32. Reproducible and fast; fine for
 *  simulation, catastrophic for real-money outcome determination. */
export function mulberry32(seed: number): SeededRng {
  let s = seed >>> 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, { __insecureSimulatorRng: true as const });
}
