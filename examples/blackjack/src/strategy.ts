// Blackjack policies as simulator StrategyFns. Each reads only the PUBLIC
// context (the latest `ops` the math emitted + the offered `awaiting.options`),
// never the opaque state - exactly what a real player sees. `basicStrategy` is
// the optimal-ish policy (basic strategy for S17, double any two, no split).

import type { StrategyFn, FlowLabel } from "../../../packages/simulator/src/index.js";

interface HandCtx { total: number; soft: boolean; dealerUp: number }

/** Basic strategy for a hit/stand game (S17, no double/split): the optimal
 *  hit-vs-stand decision per hand total and dealer upcard (2..11, ace = 11). */
export function basicMove({ total, soft, dealerUp: d }: HandCtx): "hit" | "stand" {
  if (soft) {
    if (total >= 19) return "stand";              // soft 19+
    if (total === 18) return d <= 8 ? "stand" : "hit"; // A,7: stand vs 2-8, hit 9/10/A
    return "hit";                                 // soft <= 17
  }
  if (total >= 17) return "stand";
  if (total >= 13) return d <= 6 ? "stand" : "hit";  // 13-16: stand vs 2-6
  if (total === 12) return d >= 4 && d <= 6 ? "stand" : "hit";
  return "hit";                                   // <= 11
}

const latest = (ops: unknown[]): HandCtx => ops[ops.length - 1] as HandCtx;

/** Optimal hit/stand policy: basic strategy reading the public ops. */
export const basicStrategy: StrategyFn = ({ awaiting, ops }) =>
  ({ type: awaiting.type, value: basicMove(latest(ops)) });

// --- naive baselines, to show how much the policy matters ---------------
export const mimicDealer: StrategyFn = ({ awaiting, ops }) =>
  ({ type: awaiting.type, value: latest(ops).total < 17 ? "hit" : "stand" });

export const alwaysStand: StrategyFn = ({ awaiting }) =>
  ({ type: awaiting.type, value: "stand" });

export const alwaysHit: StrategyFn = ({ awaiting }) =>
  ({ type: awaiting.type, value: "hit" });

export const randomPlay: StrategyFn = ({ awaiting, rng }) => {
  const opts = awaiting.options as string[];
  return { type: awaiting.type, value: opts[Math.floor(rng() * opts.length)] };
};

/** Coarse player-state buckets for the play-flow chart (a legible Markov chain
 *  instead of one node per total). */
export const bucketLabel: FlowLabel = ({ ops }) => {
  const o = ops[ops.length - 1] as { total: number; soft: boolean } | undefined;
  if (!o) return "?";
  if (o.soft) return `soft ${o.total}`;
  if (o.total <= 11) return "hard <=11";
  if (o.total <= 16) return "hard 12-16 (stiff)";
  return "hard 17+";
};
