// twin-gamble: a COMPLEX round - open / step / close - written as TS math.
//
// The twin of maths/gamble.zig. test/twin-gamble.test.ts proves the two return
// identical outcomes for the same RNG stream, which is what makes the pair
// worth keeping: it demonstrates the two remaining tiers agree on multi-step
// state, not just on a single draw.
//
//   open()  deals a base win from a paytable (EV 0.96); a win > 0 awaits a decision
//   step()  one FAIR gamble - heads doubles, tails busts to 0
//   close() pays whatever survived
//
// Because the gamble is fair, round RTP equals the base paytable's 0.96 under
// ANY player policy. Gambling moves variance, not expectation - which is why
// this game is safe to ship without an optimal-play analysis.
//
// Keep baseWin() and gamble.zig's in lock-step or the parity test fails.

import type { ComplexMath, MathHost } from "@open-rgs/contract";

const MAX_GAMBLES = 8;   // 2^8 = 256x the base win, max
const P_WIN = 0.5;       // fair double-or-nothing

/** Base paytable. MUST mirror gamble.zig's baseWin(). EV = 0.18*2 + 0.60*1 = 0.96 */
function baseWin(r: number): number {
  if (r < 0.18) return 2;
  if (r < 0.78) return 1;
  return 0;
}

/** State is "gambles,done,win" - a string, because RoundState is opaque to core
 *  and a readable one keeps the audit log legible. */
function encode(gambles: number, done: number, win: number): string {
  return `${gambles},${done},${win}`;
}

function decode(state: string): [number, number, number] {
  const [g, d, w] = state.split(",").map(Number);
  return [g ?? 0, d ?? 0, w ?? 0];
}

/** Mirrors gamble.zig's encodeProgress() exactly:
 *  `{ state, ops: [{ event, win }], awaiting?: { type: "gamble" } }`.
 *  The op key is `event`, not `kind`, and a non-terminal outcome carries the
 *  `awaiting` hint - both are part of the wire shape the parity test compares,
 *  so drifting on either breaks the twin. */
function progress(gambles: number, done: number, win: number, event: string) {
  const terminal = done === 1;
  return {
    state: encode(gambles, done, win),
    ops: [{ event, win }],
    ...(terminal ? {} : { awaiting: { type: "gamble" } }),
  };
}

export default function createMath(host: MathHost): ComplexMath {
  return {
    kind: "complex",
    name: "twin-gamble",
    version: "1.0.0",
    rtp: 0.96, // policy-invariant: the gamble is fair

    open() {
      const w = baseWin(host.rng_next());
      const done = w === 0 ? 1 : 0; // a losing deal has nothing to gamble
      return progress(0, done, w, "deal");
    },

    step(state) {
      // Single action type ("gamble"); the wrapper validated it, so the action
      // itself is never inspected.
      let [gambles, done, win] = decode(state);
      if (host.rng_next() < P_WIN) {
        win = win * 2;
        gambles += 1;
        if (gambles >= MAX_GAMBLES) done = 1; // cap reached -> terminal
      } else {
        win = 0;
        done = 1;                             // busted
      }
      return progress(gambles, done, win, win === 0 ? "bust" : "gamble");
    },

    isTerminal(state) {
      return decode(state)[1] === 1;
    },

    close(state) {
      const win = decode(state)[2];
      return { multiplier: win, ops: [], type: win > 0 ? "win" : "loss" };
    },

    // External-trigger autoclose (wallet/admin), never timer-driven inside the RGS.
    autoclose(state) {
      const win = decode(state)[2];
      return { multiplier: win, ops: [], type: win > 0 ? "win" : "loss" };
    },
  };
}
