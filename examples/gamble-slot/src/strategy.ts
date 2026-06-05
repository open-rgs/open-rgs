// Gamble-slot policies as simulator StrategyFns. Each reads only the PUBLIC
// context (the latest ops: { win, gambles }) - what a real player sees - and
// chooses "gamble" or "collect".

import type { StrategyFn, FlowLabel } from "../../../packages/simulator/src/index.js";

interface GCtx { win: number; gambles: number }
const ctx = (ops: unknown[]): GCtx => (ops[ops.length - 1] as GCtx | undefined) ?? { win: 0, gambles: 0 };

export const neverGamble: StrategyFn = ({ awaiting }) => ({ type: awaiting.type, value: "collect" });
export const alwaysGamble: StrategyFn = ({ awaiting }) => ({ type: awaiting.type, value: "gamble" });

/** Gamble until you've doubled `n` times, then collect. n=1 => gamble once. */
export function gambleToTarget(n: number): StrategyFn {
  return ({ awaiting, ops }) => ({ type: awaiting.type, value: ctx(ops).gambles < n ? "gamble" : "collect" });
}

export const gambleOnce: StrategyFn = gambleToTarget(1);

/** Label flow nodes by how many times we've doubled so far. */
export const gambleLabel: FlowLabel = ({ ops }) => `won, ${ctx(ops).gambles}x doubled`;
