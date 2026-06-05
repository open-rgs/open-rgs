// Pluggable complex-round strategy: simulate() can take a policy FUNCTION, not
// just "first"/"random". The strategy sees the public context (awaiting + the
// latest ops), never the opaque state - so it can only act on what a real
// client sees. This is how you model "keep gambling N times", basic strategy,
// an optimal solver, etc.

import { describe, expect, test } from "bun:test";
import { simulate, type StrategyFn } from "../src/index.js";
import { defineGame, type ComplexMath, type GameManifest } from "@open-rgs/contract";

// Trivial complex math: open() offers a pick of {1,2,3}; the chosen value IS the
// payout; one step then terminal. Lets us prove the strategy's CHOICE flows
// through step -> close and that it receives the public ops.
function pickGame(): ComplexMath {
  return {
    kind: "complex",
    name: "pick",
    version: "1.0.0",
    rtp: 0.95, // metadata only; measured RTP below comes from the payouts
    open: () => ({ state: "", ops: [{ phase: "open" }], awaiting: { type: "pick", options: [1, 2, 3] } }),
    step: (_state, action) => ({ state: String(action["value"] ?? 0), ops: [], awaiting: undefined }),
    isTerminal: (state) => state !== "",
    close: (state) => ({ multiplier: Number(state || 0), ops: [], type: "win" }),
  };
}
const game = (m: ComplexMath): GameManifest =>
  defineGame({ id: "pick", declaredRtp: 0.95, defaultMode: "default", modes: { default: { math: m, stakeMultiplier: 1 } } });

describe("simulate() pluggable complex strategy", () => {
  test("a custom StrategyFn's choice flows into step -> close", async () => {
    const pickHighest: StrategyFn = ({ awaiting }) =>
      ({ type: awaiting.type, value: Math.max(...(awaiting.options as number[])) });
    const [r] = await simulate(game(pickGame()), { complexStrategy: pickHighest, spinsPerMode: 200 });
    expect(r!.rtp.measured).toBeCloseTo(3, 6); // always picks 3
  });

  test("built-in 'first' still picks options[0]", async () => {
    const [r] = await simulate(game(pickGame()), { complexStrategy: "first", spinsPerMode: 200 });
    expect(r!.rtp.measured).toBeCloseTo(1, 6); // options[0] = 1
  });

  test("the strategy receives the public ops, and a step index", async () => {
    let sawOps = false;
    let firstStep = -1;
    const spy: StrategyFn = ({ awaiting, ops, step }) => {
      if (Array.isArray(ops) && ops.length > 0) sawOps = true; // open() emitted [{phase:"open"}]
      if (firstStep < 0) firstStep = step;
      return { type: awaiting.type, value: 2 };
    };
    const [r] = await simulate(game(pickGame()), { complexStrategy: spy, spinsPerMode: 1 });
    expect(sawOps).toBe(true);
    expect(firstStep).toBe(0);
    expect(r!.rtp.measured).toBeCloseTo(2, 6);
  });
});
