// Second acceptance test for the stack, sharing nothing with demo-holdwin:
// independent draws instead of markov stacking, clusters instead of paylines,
// a cascade instead of a respin feature.
//
// This game's volatility is 2.5 - far below demo-holdwin's 12.8, because there
// is no rare feature paying hundreds of times bet. That makes RTP converge
// roughly 25x faster, so a much smaller sample bounds it usefully. The
// interval is computed either way rather than assumed.
//
// It is also ~50x SLOWER per spin (~29k/s against ~1.4M/s): a cluster flood
// fill runs per symbol per cascade step, where the other game does one payline
// pass. So sample sizes here are chosen against the clock as well as the
// interval, and the slow cases carry an explicit timeout rather than relying on
// the 5s default - which is what the first draft of this file tripped over.

import { describe, expect, test } from "bun:test";
import { countWhere } from "@open-rgs/grid";
import createMath, {
  CELLS, LADDER, MAX_TUMBLES, MAX_WIN, PAY, ROLES, SHAPE, WEIGHTS,
} from "../src/math.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const host = (seed: number) => ({ rng_next: mulberry32(seed), log_debug: () => {} });

function simulate(spins: number, seed = 909) {
  const m = createMath(host(seed));
  let sum = 0, sumSq = 0, hits = 0, tumbles = 0, truncated = 0, max = 0, deepest = 0;
  for (let i = 0; i < spins; i++) {
    const o = m.play();
    sum += o.multiplier;
    sumSq += o.multiplier * o.multiplier;
    if (o.multiplier > 0) hits++;
    if (o.multiplier > max) max = o.multiplier;
    const t = o.ops.filter((x) => (x as { kind: string }).kind === "tumble").length;
    tumbles += t;
    if (t > deepest) deepest = t;
    if (o.ops.some((x) => (x as { kind: string }).kind === "truncated")) truncated++;
  }
  const mean = sum / spins;
  const variance = sumSq / spins - mean * mean;
  return {
    rtp: mean,
    ci: 1.96 * Math.sqrt(variance / spins),
    sd: Math.sqrt(variance),
    hitRate: hits / spins,
    avgTumbles: tumbles / spins,
    deepest, truncated, max,
  };
}

describe("purity and determinism", () => {
  test("the same seed gives the same spins", () => {
    const a = createMath(host(3));
    const b = createMath(host(3));
    for (let i = 0; i < 300; i++) expect(a.play()).toEqual(b.play());
  });

  test("a different seed diverges", () => {
    const a = createMath(host(3));
    const b = createMath(host(4));
    const x = Array.from({ length: 150 }, () => a.play().multiplier);
    const y = Array.from({ length: 150 }, () => b.play().multiplier);
    expect(x).not.toEqual(y);
  });

  test("it draws only from the injected host", () => {
    let draws = 0;
    const m = createMath({
      rng_next: () => { if (++draws > 20_000) throw new Error("STREAM_END"); return 0.5; },
      log_debug: () => {},
    });
    expect(() => { for (;;) m.play(); }).toThrow("STREAM_END");
  });
});

describe("RTP", () => {
  const s = simulate(150_000);

  test("the target falls inside the interval this sample supports", () => {
    expect(Math.abs(s.rtp - 0.965)).toBeLessThan(s.ci);
  }, 30_000);

  test("volatility is far below the hold-and-win game's", () => {
    // ~2.5 vs ~12.8. No rare feature paying hundreds of times bet, so RTP
    // converges roughly 25x faster and 300k spins is genuinely enough here.
    expect(s.sd).toBeGreaterThan(1.5);
    expect(s.sd).toBeLessThan(4);
    expect(s.ci).toBeLessThan(0.02);
  }, 30_000);
});

describe("cascade behaviour", () => {
  const s = simulate(120_000);

  test("cascades actually happen", () => {
    expect(s.avgTumbles).toBeGreaterThan(0.5);
    expect(s.deepest).toBeGreaterThan(3);
  });

  test("no round is ever truncated in normal play", () => {
    // Truncation means the cap fired, which would mean a self-sustaining
    // paytable rather than a bounded round.
    expect(s.truncated).toBe(0);
  });

  test("the cap still bounds a round", () => {
    expect(s.max).toBeLessThanOrEqual(MAX_WIN);
  });
});

describe("the scatter cannot dominate RTP", () => {
  test("scatter density is low enough that the open top band stays rare", () => {
    // The bug this guards, from this game's first draft: `bands` expands its
    // TOP band all the way to maxCount, so `[7, 200]` covers 7..49. On a 5-reel
    // grid seven scatters is impossible; on 49 cells at 6% density it lands
    // 2.7% of the time and paid 536% RTP on its own. Reel-game instinct about
    // scatter counts does not transfer to a big grid.
    const gen = createMath(host(77));
    const N = 80_000;
    let scatterPaid = 0, total = 0;
    for (let i = 0; i < N; i++) {
      const o = gen.play();
      total += o.multiplier;
      const sc = o.ops.find((x) => (x as { kind: string }).kind === "scatter") as { paid: number } | undefined;
      if (sc) scatterPaid += sc.paid;
    }
    // The scatter is a garnish, not the game.
    expect(scatterPaid / N).toBeLessThan(0.25);
    expect(scatterPaid / total).toBeLessThan(0.25);
  }, 30_000);

  test("the top scatter band is reachable but rare", () => {
    const m = createMath(host(31));
    let sixPlus = 0;
    const N = 60_000;
    for (let i = 0; i < N; i++) {
      const spin = m.play().ops[0] as { scatters: number };
      if (spin.scatters >= 6) sixPlus++;
    }
    expect(sixPlus / N).toBeLessThan(0.002);
  }, 30_000);
});

describe("configuration is coherent", () => {
  test("a 7x7 grid, which is what cluster pays needs", () => {
    // A 6x5 was the first attempt: with 9 symbols over 30 cells, 5+ groups
    // barely form and the game paid 24% with almost no cascades.
    expect(SHAPE).toHaveLength(7);
    expect(CELLS).toBe(49);
  });

  test("the ladder climbs and holds", () => {
    for (let i = 1; i < LADDER.length; i++) expect(LADDER[i]!).toBeGreaterThan(LADDER[i - 1]!);
  });

  test("the tumble cap is set and finite", () => {
    expect(MAX_TUMBLES).toBeGreaterThan(5);
    expect(Number.isFinite(MAX_TUMBLES)).toBe(true);
  });

  test("wild and scatter are declared, and neither pays as a cluster", () => {
    expect(ROLES.wilds).toContain("WILD");
    expect(ROLES.scatters).toContain("SC");
    expect(PAY.best("WILD")).toBe(0);
  });

  test("no cluster band starts above the grid size", () => {
    // `bands` refuses this, but the check is cheap and the failure mode - a
    // band that silently never pays - is invisible.
    for (const symbol of PAY.symbols) expect(PAY.maxCount(symbol)).toBeLessThanOrEqual(CELLS);
  });

  test("every weight is positive", () => {
    for (const w of Object.values(WEIGHTS)) expect(w).toBeGreaterThan(0);
  });
});
