// @open-rgs/meters - "collect five of these and something happens".
//
// The mechanic under the fisherman's counter, the coin meter, the bar that
// fills across a feature. It is bookkeeping, which is exactly why it is worth
// having in one place: the errors are all about WHEN, not what. A meter that
// awards twice at the same threshold, a meter that resets when it should
// carry, a threshold crossed by a spin that collected three at once and only
// paid for the first.
//
// Everything is a multiple of bet, and a meter never draws randomness: it
// counts what the board already produced.

/** A threshold and what reaching it awards. */
export interface Threshold<A> {
  /** Count at which this fires. */
  readonly at: number;
  /** What the game gets. An award is yours to interpret: a multiplier, a tier
   *  name, a number of spins. */
  readonly award: A;
}

export interface MeterConfig<A> {
  /** Thresholds, in any order. Fired in ascending order when a single spin
   *  crosses several at once. */
  readonly thresholds: ReadonlyArray<Threshold<A>>;
  /** Start again from zero after the highest threshold, so the meter can be
   *  filled more than once in a feature. Default false: it stops at the top. */
  readonly repeat?: boolean;
}

export interface Meter<A> {
  /** What has been counted. */
  readonly count: number;
  /** Thresholds already awarded, so none of them fires twice. */
  readonly awarded: readonly number[];
  /** Times the meter has been filled and restarted, under `repeat`. */
  readonly laps: number;
}

/** An empty meter. */
export function meter<A>(): Meter<A> {
  return { count: 0, awarded: [], laps: 0 };
}

/**
 * Add to the meter and report what that crossed.
 *
 * A spin that collects three symbols at once crosses every threshold in
 * between, and each one is awarded, in ascending order. Awarding only the
 * highest is the common bug, and it is invisible until someone reconciles a
 * big spin against the paytable.
 */
export function collect<A>(
  m: Meter<A>,
  amount: number,
  cfg: MeterConfig<A>,
): { meter: Meter<A>; awards: A[] } {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`collect: amount must be a non-negative number, got ${amount}`);
  }
  if (amount === 0) return { meter: m, awards: [] };

  const sorted = [...cfg.thresholds].sort((a, b) => a.at - b.at);
  const top = sorted[sorted.length - 1];
  let count = m.count + amount;
  let awarded = [...m.awarded];
  let laps = m.laps;
  const awards: A[] = [];

  for (;;) {
    let fired = false;
    for (const t of sorted) {
      if (count >= t.at && !awarded.includes(t.at)) {
        awards.push(t.award);
        awarded.push(t.at);
        fired = true;
      }
    }
    // Filling the meter under `repeat` starts a new lap with whatever is left
    // over, so a spin that overshoots the top does not lose its remainder. A
    // remainder that already reaches the first threshold of the new lap
    // awards it immediately, rather than waiting for a spin that adds nothing:
    // the player collected those symbols.
    if (cfg.repeat && top && count >= top.at && awarded.length === sorted.length) {
      count -= top.at;
      awarded = [];
      laps += 1;
      if (count < (sorted[0]?.at ?? Infinity)) break;
      continue;
    }
    if (!fired) break;
    if (!cfg.repeat) break;
  }

  return { meter: { count, awarded, laps }, awards };
}

/** How far to the next threshold, or 0 when the meter is full. The number a
 *  client puts on the bar. */
export function toNext<A>(m: Meter<A>, cfg: MeterConfig<A>): number {
  const next = [...cfg.thresholds].sort((a, b) => a.at - b.at).find((t) => !m.awarded.includes(t.at));
  return next ? Math.max(0, next.at - m.count) : 0;
}

/** Progress toward the next threshold, in [0, 1], for a bar that fills. */
export function progress<A>(m: Meter<A>, cfg: MeterConfig<A>): number {
  const sorted = [...cfg.thresholds].sort((a, b) => a.at - b.at);
  const nextIndex = sorted.findIndex((t) => !m.awarded.includes(t.at));
  if (nextIndex === -1) return 1;
  const from = nextIndex === 0 ? 0 : sorted[nextIndex - 1]!.at;
  const to = sorted[nextIndex]!.at;
  if (to <= from) return 1;
  return Math.min(1, Math.max(0, (m.count - from) / (to - from)));
}

/** Is every threshold awarded? */
export function isFull<A>(m: Meter<A>, cfg: MeterConfig<A>): boolean {
  return cfg.thresholds.every((t) => m.awarded.includes(t.at));
}

/** Start over, keeping the lap count so a report can say how many times the
 *  meter was filled. */
export function reset<A>(m: Meter<A>): Meter<A> {
  return { count: 0, awarded: [], laps: m.laps };
}

/**
 * Expected awards per spin, given how much a spin collects on average.
 *
 * The arithmetic a designer tunes against: a meter at 10 with an average of
 * 0.4 collected per spin fires roughly every 25 spins, so a feature of 10
 * spins fires it about 40% of the time. Cheap to compute and much easier to
 * reason about than a simulation that only tells you the answer for the
 * numbers you already chose.
 */
export function spinsToFill<A>(cfg: MeterConfig<A>, perSpin: number): number {
  if (!(perSpin > 0)) return Infinity;
  const top = [...cfg.thresholds].sort((a, b) => a.at - b.at).pop();
  return top ? top.at / perSpin : 0;
}
