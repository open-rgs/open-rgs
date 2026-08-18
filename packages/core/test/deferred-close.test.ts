// Deferred close turns a simple math into a complex round so the client can
// finish it explicitly. The tests that matter are the ones about WHEN the
// outcome is decided and WHAT a late close pays - because the whole point is
// that a player who disappears and comes back is neither penalised nor
// rewarded for the gap.

import { describe, expect, test } from "bun:test";
import { withDeferredClose, END_ROUND_ACTION, isAwaitingEndRound } from "../src/deferred-close.js";
import type { ComplexMath, SimpleMath } from "@open-rgs/contract";

const ctx = { mode: "default" } as const;

/** Simple math whose outcome depends on both the RNG and the incoming carry,
 *  so a replay has to get both right to match. */
function makeSimple(rng: () => number): SimpleMath {
  return {
    kind: "simple",
    name: "s",
    version: "1.0.0",
    rtp: 0.96,
    play(prev) {
      const r = rng();
      const carried = prev ? Number(prev) : 0;
      return {
        multiplier: r < 0.5 ? 2 : 0,
        ops: [{ kind: "spin", r, carried }],
        type: r < 0.5 ? "win" : "loss",
        carry: String(carried + 1),
      };
    },
  };
}

const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]!; };

describe("shape", () => {
  test("a simple math becomes a complex one", () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    expect(m.kind).toBe("complex");
  });

  test("metadata carries over, including the provenance hash", () => {
    const base = { ...makeSimple(seq([0.1])), contentHash: "abc123" };
    const m = withDeferredClose(base as SimpleMath);
    expect(m.name).toBe("s");
    expect(m.version).toBe("1.0.0");
    expect(m.rtp).toBe(0.96);
    expect(m.contentHash).toBe("abc123");
  });

  test("it awaits the end-round action, which is how a client recognises it", async () => {
    const m = withDeferredClose(makeSimple(seq([0.1])), { prompt: "Tap to collect" });
    const open = await m.open(undefined, ctx);
    expect(open.awaiting?.type).toBe(END_ROUND_ACTION);
    expect(open.awaiting?.prompt).toBe("Tap to collect");
    expect(isAwaitingEndRound(open.awaiting?.type)).toBe(true);
    expect(isAwaitingEndRound("gamble")).toBe(false);
  });
});

describe("the outcome is decided at OPEN", () => {
  test("open runs the math exactly once", async () => {
    let calls = 0;
    const m = withDeferredClose({
      ...makeSimple(seq([0.1])),
      play() { calls++; return { multiplier: 1, ops: [], type: "win" }; },
    } as SimpleMath);
    const open = await m.open(undefined, ctx);
    m.close(open.state);
    m.close(open.state);
    expect(calls).toBe(1);
  });

  test("closing pays what open decided", async () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));  // 0.1 -> win, 2x
    const open = await m.open(undefined, ctx);
    const closed = await m.close(open.state);
    expect(closed.multiplier).toBe(2);
    expect(closed.type).toBe("win");
  });

  test("a losing spin still opens, and closes at zero", async () => {
    const m = withDeferredClose(makeSimple(seq([0.9])));  // 0.9 -> loss
    const open = await m.open(undefined, ctx);
    expect(open.awaiting?.type).toBe(END_ROUND_ACTION);
    expect((await m.close(open.state)).multiplier).toBe(0);
  });

  test("closing twice pays the same both times", async () => {
    // The orchestrator will not do this, but the state must be a pure value
    // rather than something consumed by reading it.
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open(undefined, ctx);
    expect(await m.close(open.state)).toEqual(await m.close(open.state));
  });

  test("ops are emitted at OPEN so the client can render immediately", async () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open(undefined, ctx);
    expect(open.ops).toHaveLength(1);
    // ...and not repeated at close, or the client would render the spin twice.
    expect((await m.close(open.state)).ops).toEqual([]);
  });
});

describe("terminal from the moment it opens", () => {
  test("isTerminal is true immediately", async () => {
    // If this were false the orchestrator would reject closeRound with
    // INVALID_ROUND and the round could never be finished at all.
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open(undefined, ctx);
    expect(m.isTerminal(open.state)).toBe(true);
  });

  test("stepping is refused - there are no decisions to make", async () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open(undefined, ctx);
    expect(() => (m as ComplexMath).step(open.state, { type: "gamble" }))
      .toThrow(/takes no steps/);
  });
});

describe("carry and mode routing survive the deferral", () => {
  test("carry threads through open and comes back at close", async () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open("7", ctx);
    expect((await m.close(open.state)).carry).toBe("8");
  });

  test("nextMode survives", async () => {
    const m = withDeferredClose({
      ...makeSimple(seq([0.1])),
      play() { return { multiplier: 1, ops: [], type: "win", nextMode: "free-spins" }; },
    } as SimpleMath);
    const open = await m.open(undefined, ctx);
    expect((await m.close(open.state)).nextMode).toBe("free-spins");
  });

  test("absent carry stays absent rather than becoming undefined-ish", async () => {
    const m = withDeferredClose({
      ...makeSimple(seq([0.1])),
      play() { return { multiplier: 1, ops: [], type: "win" }; },
    } as SimpleMath);
    const closed = await m.close((await m.open(undefined, ctx)).state);
    expect("carry" in closed).toBe(false);
  });
});

describe("autoclose pays the same as a normal close", () => {
  test("an abandoned round settles at its decided value", async () => {
    // A player who never came back is not penalised; one who came back late is
    // not rewarded. Both get what open decided.
    const m = withDeferredClose(makeSimple(seq([0.1])));
    const open = await m.open("3", ctx);
    expect(await m.autoclose!(open.state)).toEqual(await m.close(open.state));
  });
});

describe("a state this wrapper did not produce is refused", () => {
  test("non-JSON state fails loudly", () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    expect(() => m.close("not json")).toThrow(/not a parked outcome/);
  });

  test("JSON missing the outcome fails loudly", () => {
    const m = withDeferredClose(makeSimple(seq([0.1])));
    expect(() => m.close('{"nope":1}')).toThrow(/missing its multiplier or ops/);
  });
});
