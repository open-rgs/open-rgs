// twin-slot: the SAME minimal SIMPLE-round slot as
// maths/slot.zig, written as a TS math module.
//
// The three are a matched set. test/twin-slot.test.ts proves they return
// identical outcomes for the same RNG stream - read them side by side to see
// the same game in each runtime.
//
// The game: one RNG draw -> a paytable. EV (RTP) = 0.96:
//     0.02*20 + 0.04*5 + 0.36*1 = 0.40 + 0.20 + 0.36 = 0.96
// Keep this ladder and slot.zig's decide() in lock-step - same
// thresholds, same payouts, exactly one draw - or the parity test fails.
//
// NOTE the shape: the module default-exports a FACTORY taking the host, not a
// bare math object. That is the RNG seam. A TS math draws through
// `host.rng_next()` exactly as the Zig twin imports `host.rng_next` - one auditable source in all three
// runtimes, and no way for the math to reach an ambient generator.

import type { MathHost, SimpleMath } from "../../../packages/contract/src/index.js";

export default function createMath(host: MathHost): SimpleMath {
  return {
    kind: "simple",
    name: "twin-slot",
    version: "1.0.0",
    rtp: 0.96,

    play() {
      const r = host.rng_next();

      let mult: number;
      if (r < 0.02) mult = 20;
      else if (r < 0.06) mult = 5;
      else if (r < 0.42) mult = 1;
      else mult = 0;

      return {
        multiplier: mult,
        ops: [{ kind: "spin", mult }],
        type: mult > 0 ? "win" : "loss",
      };
    },
  };
}
