// Blackjack as an open-rgs COMPLEX math, for studying "options" in simulation.
// open() deals; step() takes hit / stand / double; close() plays the dealer and
// settles. The point of the example: the RTP depends entirely on the player's
// POLICY, and the optimal policy (basic strategy) is a state-dependent function
// of the public context the math exposes via `ops`.
//
// Rules (fixed, documented): infinite deck (cards i.i.d.), dealer stands on all
// 17 (S17), blackjack pays 3:2, double on any first two cards. NO split /
// surrender / insurance - see README for why (split/double change the WAGER,
// which open-rgs's fixed-bet, money-moves-<=-twice model doesn't move mid-round;
// double here is expressed as a 2x multiplier for RTP measurement).
//
// Currency-blind + RNG-injected, like any open-rgs math: it never sees the bet,
// only returns a multiplier; all randomness comes from the injected `rng`.

import type { ComplexMath, RoundState, SpinContext, PlayerAction } from "../../../packages/contract/src/index.js";

interface BJState {
  p: number[];   // player card ranks (1=A, 2..13)
  du: number;    // dealer upcard rank
  dh: number;    // dealer hole rank (drawn at open, hidden until close)
  doubled: boolean;
  done: boolean;
  ret: number | null; // resolved return (naturals / bust); null => close plays dealer
}

/** Best total <= 21 for a set of ranks, and whether it's "soft" (an ace still
 *  counted as 11). */
export function handTotal(ranks: number[]): { total: number; soft: boolean } {
  let total = 0;
  let acesAt11 = 0;
  for (const r of ranks) {
    if (r === 1) { acesAt11 += 1; total += 11; }
    else total += r >= 10 ? 10 : r;
  }
  while (total > 21 && acesAt11 > 0) { total -= 10; acesAt11 -= 1; }
  return { total, soft: acesAt11 > 0 };
}

const retType = (m: number): string => (m === 0 ? "lose" : m === 1 ? "push" : "win");

/** Build a blackjack ComplexMath driven by the injected `rng` (in [0,1)). */
export function makeBlackjack(rng: () => number): ComplexMath {
  const draw = (): number => 1 + Math.floor(rng() * 13); // rank 1..13

  // The public context a player/strategy can see at a decision point.
  const ctxOps = (s: BJState): unknown[] => {
    const { total, soft } = handTotal(s.p);
    return [{ total, soft, dealerUp: s.du === 1 ? 11 : s.du >= 10 ? 10 : s.du }];
  };
  // hit / stand only. Double & split CHANGE THE WAGER mid-round, which open-rgs's
  // fixed-bet model (money moves <= twice: open debit, close credit) doesn't do -
  // so they're out of a faithful served game (see README). That also keeps the
  // RTP denominator honest: every round wagers exactly the base bet.
  const options = (): unknown[] => ["hit", "stand"];

  return {
    kind: "complex",
    name: "blackjack",
    version: "1.0.0",
    rtp: 0.99, // metadata; real RTP is policy-dependent (measured in the study)

    open(_prev: RoundState | undefined, _ctx: SpinContext) {
      const s: BJState = { p: [draw(), draw()], du: draw(), dh: draw(), doubled: false, done: false, ret: null };
      const player = handTotal(s.p).total;
      const dealer = handTotal([s.du, s.dh]).total;
      const playerBJ = player === 21;
      const dealerBJ = dealer === 21;
      if (playerBJ || dealerBJ) {
        s.done = true;
        s.ret = playerBJ && dealerBJ ? 1 : playerBJ ? 2.5 : 0; // 3:2 blackjack
        return { state: JSON.stringify(s), ops: ctxOps(s), awaiting: undefined };
      }
      return { state: JSON.stringify(s), ops: ctxOps(s), awaiting: { type: "act", options: options() } };
    },

    step(stateStr: RoundState, action: PlayerAction) {
      const s: BJState = JSON.parse(stateStr);
      const move = String(action["value"] ?? "stand");
      if (move === "hit") {
        s.p.push(draw());
        if (handTotal(s.p).total > 21) { s.done = true; s.ret = 0; return { state: JSON.stringify(s), ops: ctxOps(s), awaiting: undefined }; }
        return { state: JSON.stringify(s), ops: ctxOps(s), awaiting: { type: "act", options: options() } };
      }
      // stand
      s.done = true;
      return { state: JSON.stringify(s), ops: ctxOps(s), awaiting: undefined };
    },

    isTerminal(stateStr: RoundState): boolean {
      return (JSON.parse(stateStr) as BJState).done;
    },

    close(stateStr: RoundState) {
      const s: BJState = JSON.parse(stateStr);
      if (s.ret !== null) return { multiplier: s.ret, ops: [], type: s.ret >= 2 ? "blackjack" : retType(s.ret) };
      // Player stood or doubled without busting: play the dealer (S17).
      const dealer = [s.du, s.dh];
      let dt = handTotal(dealer);
      while (dt.total < 17) { dealer.push(draw()); dt = handTotal(dealer); }
      const pt = handTotal(s.p).total;
      let base: number;
      if (dt.total > 21 || pt > dt.total) base = 2;     // dealer bust or player higher -> win
      else if (pt === dt.total) base = 1;               // push
      else base = 0;                                    // lose
      const mult = base * (s.doubled ? 2 : 1);
      return { multiplier: mult, ops: [], type: retType(base) };
    },
  };
}
