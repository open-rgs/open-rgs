// The smallest possible math: one draw, a three-rung paytable.
//
// Note the shape - a FACTORY taking the host, not a bare object. That is the
// RNG seam: the math has no other source of randomness, and loadTsMath rejects
// a bare-object export for exactly that reason.

import type { MathHost, SimpleMath } from "@open-rgs/contract";

export default function createMath(host: MathHost): SimpleMath {
  return {
    kind: "simple",
    name: "spin",
    version: "0.1.0",
    rtp: 0.95,

    play() {
      const r = host.rng_next();
      const m = r < 0.30 ? 0.5 : r < 0.40 ? 2 : r < 0.41 ? 50 : 0;
      return {
        multiplier: m,
        ops: [{ kind: "result", multiplier: m }],
        type: m > 0 ? "win" : "loss",
      };
    },
  };
}
