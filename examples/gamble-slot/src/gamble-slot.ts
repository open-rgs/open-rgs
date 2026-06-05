// Gamble slot: the simplest COMPLEX round that fits open-rgs's money model.
//
// One bet at open (price x stake x betIndex - debited once). A base spin pays a
// win; then the player may GAMBLE the win on a fair coin flip - double it or
// lose it - up to 8 times (max 2^8 = 256x the win), or COLLECT. Crucially you
// only ever risk the WON amount (the multiplier), never a second bet, so the
// payout stays `multiplier x bet` with multiplier >= 0. No mid-round debit. This
// is why a gamble feature is expressible where blackjack double/split are not.
//
// Currency-blind + RNG-injected like any open-rgs math.
//
// The interesting property: the gamble is FAIR (x2 at p=0.5), so it's EV-neutral
// - the game's RTP equals the base slot's (~96%) under ANY gamble policy. The
// gamble only moves variance, not edge. The simulator proves it; the play-flow
// chart shows it. (Contrast examples/cash-ladder, whose gamble is unfair.)

import type { ComplexMath, RoundState, SpinContext, PlayerAction } from "../../../packages/contract/src/index.js";

interface GState { win: number; gambles: number; done: boolean }

const MAX_GAMBLES = 8;       // 2^8 = 256x the base win, max
const P_WIN = 0.5;           // FAIR double-or-nothing (EV-neutral)

// Base slot paytable, EV = 0.96: 2x*0.30 + 5x*0.06 + 25x*0.0024 = 0.96.
function spin(rng: () => number): number {
  const r = rng();
  if (r < 0.6376) return 0;
  if (r < 0.9376) return 2;
  if (r < 0.9976) return 5;
  return 25;
}

const ops = (s: GState): unknown[] => [{ win: s.win, gambles: s.gambles }];
const offer = (): unknown[] => ["gamble", "collect"];

/** Build a gamble-slot ComplexMath driven by the injected `rng`. */
export function makeGambleSlot(rng: () => number): ComplexMath {
  return {
    kind: "complex",
    name: "gamble-slot",
    version: "1.0.0",
    rtp: 0.96,

    open(_prev: RoundState | undefined, _ctx: SpinContext) {
      const win = spin(rng);
      const s: GState = { win, gambles: 0, done: win === 0 };
      // A losing spin has nothing to gamble -> terminal immediately.
      return { state: JSON.stringify(s), ops: ops(s), awaiting: win > 0 ? { type: "gamble", options: offer() } : undefined };
    },

    step(stateStr: RoundState, action: PlayerAction) {
      const s: GState = JSON.parse(stateStr);
      const move = String(action["value"] ?? "collect");
      if (move === "collect") {
        s.done = true;
        return { state: JSON.stringify(s), ops: ops(s), awaiting: undefined };
      }
      // gamble: fair double-or-nothing
      if (rng() < P_WIN) {
        s.win *= 2;
        s.gambles += 1;
        if (s.gambles >= MAX_GAMBLES) s.done = true; // cap reached -> auto-collect
      } else {
        s.win = 0;
        s.done = true; // busted
      }
      return { state: JSON.stringify(s), ops: ops(s), awaiting: s.done ? undefined : { type: "gamble", options: offer() } };
    },

    isTerminal(stateStr: RoundState): boolean {
      return (JSON.parse(stateStr) as GState).done;
    },

    close(stateStr: RoundState) {
      const s: GState = JSON.parse(stateStr);
      return { multiplier: s.win, ops: [], type: s.win > 0 ? "win" : "loss" };
    },
  };
}
