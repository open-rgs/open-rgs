// A 7x7 cluster-pays tumble slot.
//
// The second acceptance test for the stack, deliberately sharing nothing with
// demo-holdwin: independent per-cell draws instead of markov stacking, cluster
// pays instead of paylines, and a cascade instead of a respin feature. Between
// the two games every library is exercised by something real.
//
//   board      independent weighted draws (stacking would create giant
//              clusters, which is exactly wrong for this genre)
//   wins       orthogonally connected groups of 5+, wilds bridging
//   cascade    winners clear, symbols fall, gaps refill, multiplier climbs
//
// Pure function of a stream of floats, like everything else here.

import { type Grid, rect, sizeOf } from "@open-rgs/grid";
import { sampler } from "@open-rgs/weights";
import { fillWeights } from "@open-rgs/fill";
import { runCascade } from "@open-rgs/cascade";
import { bands, paytable, totalMultiplier, type Roles, type Win } from "@open-rgs/paytable";
import { evalAllClusters } from "@open-rgs/pay-cluster";
import { countAnywhere } from "@open-rgs/pay-anywhere";

export interface MathHost {
  rng_next(): number;
  log_debug(message: string): void;
}

export interface Outcome {
  multiplier: number;
  ops: unknown[];
  type: string;
}

export const SHAPE = rect(7, 7);
export const CELLS = sizeOf(SHAPE);

export const ROLES: Roles = { wilds: ["WILD"], scatters: ["SC"] };

/** No stacking here on purpose: correlated columns would produce huge clusters
 *  and the size bands would stop meaning anything. Cluster games want
 *  independent cells. */
export const WEIGHTS = {
  L1: 16, L2: 15, L3: 15, L4: 14, H1: 12, H2: 10, H3: 9, WILD: 7, SC: 2,
} as const;

/** Cluster games pay by SIZE BAND. `bands` expands these into the exact counts
 *  a paytable holds, capped at the grid size.
 *
 *  WATCH THE TOP BAND. It is open-ended: it covers everything from its start up
 *  to `maxCount`. On a 5-reel grid "7 or more scatters" is impossible, so the
 *  intuition from that world is that the top band is a lottery ticket. On 49
 *  cells it is not - the first draft of this game gave SC a 6% weight and a
 *  `[7, 200]` band, which lands 2.7% of the time and paid 536% RTP on its own.
 *  A scatter on a big grid needs a much lower density than reel-game instinct
 *  suggests. */
export const PAY = paytable(
  bands(
    {
      L1: [[5, 0.153], [9, 0.509], [12, 2.035], [15, 8.14], [20, 25.436]],
      L2: [[5, 0.203], [9, 0.712], [12, 2.544], [15, 10.175], [20, 32.558]],
      L3: [[5, 0.255], [9, 0.916], [12, 3.256], [15, 13.227], [20, 42.733]],
      L4: [[5, 0.305], [9, 1.119], [12, 4.07], [15, 16.279], [20, 52.907]],
      H1: [[5, 0.509], [9, 2.035], [12, 7.122], [15, 28.489], [20, 91.57]],
      H2: [[5, 0.916], [9, 3.561], [12, 12.209], [15, 48.838], [20, 162.792]],
      H3: [[5, 1.628], [9, 6.105], [12, 22.384], [15, 91.57], [20, 305.235]],
      SC: [[4, 3.5], [5, 17], [6, 85]],
    },
    CELLS,
  ),
);

/** The ladder climbs with each tumble and holds at its last rung. It applies to
 *  each step's own win - never to the running total, which would compound. */
export const LADDER = [1, 2, 3, 5, 8, 12, 20, 30] as const;

/** A cascade can in principle sustain itself forever, since every refill may
 *  win again. This bounds the round. */
export const MAX_TUMBLES = 30;

export const MAX_WIN = 5000;

const reels = fillWeights<string>(SHAPE, WEIGHTS);
const symbols = sampler(WEIGHTS);

/** Cluster wins for a board. Scatters are excluded - they pay on total count,
 *  and letting them cluster would pay them twice. */
function evaluate(grid: Grid<string>): { multiplier: number; positions: number[]; wins: Win<string>[] } {
  const wins = evalAllClusters(grid, PAY, { roles: ROLES }).filter((w) => w.symbol !== "SC");
  return {
    multiplier: totalMultiplier(wins),
    positions: wins.flatMap((w) => [...w.positions]),
    wins,
  };
}

export default function createMath(host: MathHost) {
  return {
    kind: "simple" as const,
    name: "demo-tumble",
    version: "1.0.0",
    rtp: 0.965,

    play(): Outcome {
      const start = reels(host.rng_next);

      // Scatters are counted on the OPENING board only. Counting them across
      // cascades would let a long tumble accumulate scatters that were never
      // on screen together, which is not what a player sees.
      const scatters = countAnywhere(start, "SC");
      const scatterWin = PAY.pay("SC", scatters);

      const run = runCascade(
        start,
        (g) => {
          const e = evaluate(g);
          return { multiplier: e.multiplier, positions: e.positions };
        },
        (next) => symbols.pick(next()),
        host.rng_next,
        { stepMultipliers: [...LADDER], maxSteps: MAX_TUMBLES },
      );

      const raw = run.multiplier + scatterWin;
      const capped = Math.min(raw, MAX_WIN);

      return {
        multiplier: capped,
        ops: [
          { kind: "spin", grid: start.cells, scatters },
          ...run.steps.map((s) => ({
            kind: "tumble",
            step: s.step,
            cleared: s.cleared.length,
            mult: s.stepMultiplier,
            paid: s.paid,
          })),
          ...(scatterWin > 0 ? [{ kind: "scatter", count: scatters, paid: scatterWin }] : []),
          ...(run.truncated ? [{ kind: "truncated", steps: run.steps.length }] : []),
          ...(capped < raw ? [{ kind: "maxWin", uncapped: raw }] : []),
        ],
        type: capped > 0 ? "win" : "loss",
      };
    },
  };
}
