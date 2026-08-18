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
  /** Lowest the count may go, for a meter that is spent as well as filled.
   *  Default 0. */
  readonly min?: number;
  /** Highest the count may reach. Collecting past it CLAMPS rather than
   *  throwing: a spin that collects more than the meter can hold is a good
   *  spin, not an error. Without it a meter counts without limit, which is
   *  fine for a counter and wrong for a multiplier that tops out. */
  readonly max?: number;
  /** Whether a threshold can be earned again after the count falls back below
   *  it (see `spend`). Default false, because the usual answer is no: a player
   *  who spends a meter down and refills it has collected the symbols twice
   *  but should not be paid for the same rung twice. */
  readonly reawardAfterSpend?: boolean;
}

export interface Meter<A> {
  /** What has been counted. */
  readonly count: number;
  /** Thresholds already awarded, so none of them fires twice. */
  readonly awarded: readonly number[];
  /** Times the meter has been filled and restarted, under `repeat`. */
  readonly laps: number;
}

/** An empty meter. Starts at `cfg.min` when one is set, since a meter with a
 *  floor of 1 (a multiplier, say) starts at 1 rather than at nothing. */
export function meter<A>(cfg?: MeterConfig<A>): Meter<A> {
  return { count: cfg?.min ?? 0, awarded: [], laps: 0 };
}

/** Clamp a count into the configured bounds. */
function clamp<A>(n: number, cfg: MeterConfig<A>): number {
  const lo = cfg.min ?? 0;
  const hi = cfg.max ?? Infinity;
  return Math.min(hi, Math.max(lo, n));
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
  let count = clamp(m.count + amount, cfg);
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
      count = clamp(count - top.at, cfg);
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

/**
 * Take from the meter, for one that is spent as well as filled.
 *
 * Clamps at `min`. Thresholds already earned stay earned: a player who spends
 * a meter down and fills it again has collected the symbols twice but is not
 * paid for the same rung twice, unless the game says so with
 * `reawardAfterSpend`. That default is the conservative one, and it is the
 * difference between a meter and a repeatable prize.
 */
export function spend<A>(m: Meter<A>, amount: number, cfg: MeterConfig<A>): Meter<A> {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`spend: amount must be a non-negative number, got ${amount}`);
  }
  if (amount === 0) return m;
  const count = clamp(m.count - amount, cfg);
  const awarded = cfg.reawardAfterSpend ? m.awarded.filter((at) => count >= at) : m.awarded;
  return { ...m, count, awarded };
}

/**
 * How full the meter is between its floor and its ceiling, in [0, 1].
 *
 * Different from {@link progress}, which measures the gap between the last
 * threshold and the next one. A bar that fills toward the top of the meter
 * wants this; a bar that fills toward the next prize wants that. Returns 0
 * when no `max` is configured, because an unbounded meter has no fill level.
 */
export function fillLevel<A>(m: Meter<A>, cfg: MeterConfig<A>): number {
  const lo = cfg.min ?? 0;
  const hi = cfg.max;
  if (hi === undefined || hi <= lo) return 0;
  return Math.min(1, Math.max(0, (m.count - lo) / (hi - lo)));
}

/** Is the meter at its ceiling? A capped meter that keeps collecting is
 *  usually a signal to award something else instead. */
export function isAtMax<A>(m: Meter<A>, cfg: MeterConfig<A>): boolean {
  return cfg.max !== undefined && m.count >= cfg.max;
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

// --- carry -------------------------------------------------------------------
//
// A meter that survives a spin has to live in the math's `carry`, because the
// engine keeps no per-player state of its own: carry is written with the money
// and read back when the session next opens (see open-rgs.dev/carry). That
// makes the meter's serialised shape part of the game's persisted state, and
// it means a change to that shape meets carry written by the previous version.
//
// The engine already has one rule for that: when the loaded math's version
// differs from the version stored beside the carry, the carry is discarded and
// the session starts fresh. `fromCarry` exists for the case that rule does not
// cover, which is a meter whose own shape changed WITHOUT the math version
// moving, and for games that would rather migrate than discard.

/** Bumped when the serialised shape below changes. */
export const METER_CARRY_VERSION = 1;

interface CarriedMeter {
  readonly v: number;
  readonly c: number;
  readonly a: readonly number[];
  readonly l: number;
}

/** Serialise a meter for the math's carry. Short keys, because carry crosses
 *  the wire on every settle and is stored per session. */
export function toCarry<A>(m: Meter<A>): string {
  const out: CarriedMeter = { v: METER_CARRY_VERSION, c: m.count, a: m.awarded, l: m.laps };
  return JSON.stringify(out);
}

/**
 * What to do with carry this version cannot read.
 *
 * - `"reset"` (default): start fresh. The same answer the engine gives a carry
 *   whose math version moved, and the safe one: nothing is paid twice and
 *   nothing is read with the wrong parser.
 * - `"keep-count"`: keep the progress, forget which thresholds were earned.
 *   The player keeps what they collected, and the thresholds they already
 *   passed can pay AGAIN as the count crosses them. Sometimes that is
 *   generous-but-fine, and sometimes it is paying twice for one collection:
 *   decide per game rather than per convenience.
 * - a function: read the old shape yourself and return the meter it should
 *   become. The only option that can preserve both progress and awards, and
 *   the only one that needs the old shape to be documented somewhere.
 */
export type CarryMigration<A> = "reset" | "keep-count" | ((raw: unknown, cfg: MeterConfig<A>) => Meter<A>);

/**
 * Read a meter back out of carry.
 *
 * Absent or empty carry is a fresh meter, which is the first spin of a
 * session. Anything unreadable goes through `migration`, so a game states what
 * happens to a player mid-meter when its shape changes, rather than finding
 * out on the day.
 */
export function fromCarry<A>(
  carry: string | undefined,
  cfg: MeterConfig<A>,
  migration: CarryMigration<A> = "reset",
): Meter<A> {
  if (carry === undefined || carry === "") return meter(cfg);

  let raw: unknown;
  try {
    raw = JSON.parse(carry);
  } catch {
    return migrate(undefined, cfg, migration);
  }

  const r = raw as Partial<CarriedMeter>;
  const readable =
    r !== null && typeof r === "object" &&
    r.v === METER_CARRY_VERSION &&
    typeof r.c === "number" && Array.isArray(r.a) && typeof r.l === "number";
  if (!readable) return migrate(raw, cfg, migration);

  return {
    // Clamp on the way in: the bounds may have tightened since this was
    // written, and a count outside them would make progress read past 1.
    count: clamp(r.c!, cfg),
    awarded: [...r.a!].filter((at) => typeof at === "number"),
    laps: r.l!,
  };
}

function migrate<A>(raw: unknown, cfg: MeterConfig<A>, migration: CarryMigration<A>): Meter<A> {
  if (typeof migration === "function") return migration(raw, cfg);
  if (migration === "keep-count") {
    const c = (raw as { c?: unknown } | undefined)?.c;
    return { count: typeof c === "number" ? clamp(c, cfg) : (cfg.min ?? 0), awarded: [], laps: 0 };
  }
  return meter(cfg);
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
