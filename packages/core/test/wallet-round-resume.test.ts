// A round the wallet has open and this process never opened.
//
// The RGS restarts, or the player comes back on another instance. The round
// was paid for and its state is sitting in the wallet; the RGS remembers
// nothing. Before this, the only options were to forfeit it or to settle it
// behind the player's back. Now they are put back into it and finish it.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type ComplexMath, type ConnectionMeta, type PlatformAdapter, type PlatformEvent,
  type RoundReceipt, type SessionInfo, type WalletOpenRound,
} from "@open-rgs/contract";

interface Table { pending: number; done?: boolean }

/** A gamble round: the state says what is on the table. */
function math(version = "1"): ComplexMath {
  return {
    kind: "complex", name: "gamble", version, rtp: 1,
    open: () => ({ state: JSON.stringify({ pending: 1 }), ops: [], awaiting: { type: "decide" } }),
    step: (state, action) => {
      const t = JSON.parse(state) as Table;
      if (action["choice"] === "collect") return { state: JSON.stringify({ ...t, done: true }), ops: [] };
      return { state: JSON.stringify({ pending: t.pending * 2 }), ops: [], awaiting: { type: "decide" } };
    },
    isTerminal: (state) => (JSON.parse(state) as Table).done === true,
    close: (state) => ({ multiplier: (JSON.parse(state) as Table).pending, ops: [], type: "win" }),
    resume: (state) => {
      const t = JSON.parse(state) as Table;
      // Required to throw when the state is not this math's own: that is how
      // the orchestrator identifies the owner when no mode was recorded.
      if (typeof t.pending !== "number") throw new Error("not mine");
      return t.done ? {} : { awaiting: { type: "decide" }, ops: [{ kind: "message", text: `${t.pending}x on the table` }] };
    },
  };
}

function platformWith(open: WalletOpenRound | undefined): PlatformAdapter & { closed: RoundReceipt[] } {
  const closed: RoundReceipt[] = [];
  return {
    closed,
    isHealthy: true,
    diagnostics: {},
    async connect() {}, disconnect() {},
    async openSession(sessionId): Promise<SessionInfo> {
      return {
        sessionId, currency: "USD", currencyDecimals: 2,
        balance: 10_000, allowedBets: [100, 200], defaultBetIndex: 0,
        ...(open ? { walletOpenRound: open } : {}),
      };
    },
    async settleSimple(): Promise<RoundReceipt> { throw new Error("unused"); },
    async openComplex(): Promise<RoundReceipt> { throw new Error("should not open: a round is already open"); },
    async closeComplex(req): Promise<RoundReceipt> {
      const r = { roundId: req.roundId, balance: 10_000 + req.win };
      closed.push(r);
      return r;
    },
    onEvent(_h: (e: PlatformEvent) => void) {},
  };
}

function orchestratorFor(platform: PlatformAdapter, mathVersion = "1") {
  return createOrchestrator({
    manifest: defineGame({
      id: "g", declaredRtp: 1, defaultMode: "cx",
      modes: { cx: { math: math(mathVersion), stakeMultiplier: 1 } },
    }),
    platform,
  });
}

// The session store is a module-level singleton shared by every test file in
// the process, so session ids have to be unique across the whole suite - not
// just within this file. Generic ids passed here and failed in the full run.
const conn = (): ConnectionMeta => ({ connectionId: `c-${Math.random()}`, sessionId: null, demo: false });

const openRound: WalletOpenRound = {
  roundId: "r-from-the-wallet",
  state: JSON.stringify({ pending: 4 }),
  betIndex: 1,
  priceMultiplier: 1,
  modeId: "cx",
  mathVersion: "1",
};

describe("resuming a round the wallet has open", () => {
  test("INIT puts the player back into it, with what they are being asked", async () => {
    const platform = platformWith(openRound);
    const orch = orchestratorFor(platform);
    const init = await orch.init({ sid: "wallet-resume-1" }, conn());
    expect(init.resume).toBeDefined();
    expect(init.resume?.roundId).toBe("r-from-the-wallet");
    expect(init.resume?.awaiting?.type).toBe("decide");
    // The bet is arithmetic: index 1 of this session's ladder.
    expect(init.resume?.bet).toBe(200);
    // Whatever the math could reconstruct of the round so far.
    expect(init.resume?.ops?.length).toBeGreaterThan(0);
  });

  test("and the player can finish it", async () => {
    const platform = platformWith(openRound);
    const orch = orchestratorFor(platform);
    const c = conn();
    await orch.init({ sid: "wallet-resume-2" }, c);
    await orch.stepRound({ action: { type: "decide", choice: "collect" } }, c);
    const close = await orch.closeRound({}, c);
    // 4x was on the table when the process that opened it died.
    expect(close.multiplier).toBe(4);
    expect(close.win).toBe(4 * 200);
    expect(platform.closed.map((r) => r.roundId)).toEqual(["r-from-the-wallet"]);
  });

  test("a round written by math that is gone is not resumed", async () => {
    // Its rules no longer exist. Settling it under the replacement's rules
    // would be inventing a result; it stays open and recoverable by hand.
    const platform = platformWith({ ...openRound, mathVersion: "0" });
    const orch = orchestratorFor(platform, "1");
    const init = await orch.init({ sid: "wallet-resume-3" }, conn());
    expect(init.resume).toBeUndefined();
  });

  test("without a recorded mode, the owning math is found by asking", async () => {
    const platform = platformWith({ ...openRound, modeId: undefined });
    const orch = orchestratorFor(platform);
    const init = await orch.init({ sid: "wallet-resume-4" }, conn());
    expect(init.resume?.roundId).toBe("r-from-the-wallet");
  });

  test("a state no math claims is left alone", async () => {
    const platform = platformWith({ ...openRound, modeId: undefined, state: JSON.stringify({ something: "else" }) });
    const orch = orchestratorFor(platform);
    const init = await orch.init({ sid: "wallet-resume-5" }, conn());
    expect(init.resume).toBeUndefined();
  });

  test("a bet index off this session's ladder is not resumed", async () => {
    const platform = platformWith({ ...openRound, betIndex: 99 });
    const orch = orchestratorFor(platform);
    const init = await orch.init({ sid: "wallet-resume-6" }, conn());
    expect(init.resume).toBeUndefined();
  });

  test("no open round, no resume", async () => {
    const platform = platformWith(undefined);
    const orch = orchestratorFor(platform);
    const init = await orch.init({ sid: "wallet-resume-7" }, conn());
    expect(init.resume).toBeUndefined();
  });
});
