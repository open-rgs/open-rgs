// Faulty-round simulation: an adversarial wallet and adversarial math, to prove
// the engine holds its guarantees when the layers around it misbehave.
//
//   Guarantee 5 (Fail Closed): a non-finite / negative multiplier, a wallet that
//     throws, or a math that throws must fail the round, never pay on a bad value.
//   Guarantee 1 (No Money, No Honey): a settle/open that the wallet rejects moves
//     no money and leaves no state.
//   Guarantee 7 (Bounded Payout): a runaway multiplier is capped, not paid in full.
//
// Everything is driven through the real orchestrator with a fault-injecting
// PlatformAdapter / MathModule, so these are end-to-end engine behaviours.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath,
  type ConnectionMeta, type PlatformEvent, type RoundOutcome,
} from "@open-rgs/contract";

// A wallet whose faults are toggled per test. It also tracks every net money
// move so a test can assert conservation.
class FaultyWallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  readonly start = 100_000;
  balance = 100_000;
  settles: number[] = [];      // net delta applied per successful settle
  private seq = 0;
  fault: "none" | "settle-throws" | "settle-insufficient" = "none";

  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    if (this.fault === "settle-throws") throw new Error("upstream wallet exploded");
    if (this.fault === "settle-insufficient") throw new Error("InsufficientFunds");
    const net = -req.bet + req.win;
    this.balance += net;
    this.settles.push(net);
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r${++this.seq}`, balance: this.balance }; }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

// A simple math whose output is whatever the test wants — including hostile values.
function math(out: () => RoundOutcome): SimpleMath {
  return { kind: "simple", name: "x", version: "1", rtp: 1, play: out };
}

function setup(m: SimpleMath, maxWin = 1000) {
  const platform = new FaultyWallet();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: maxWin,
    modes: { base: { math: m, stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c", sessionId: null, demo: false };
  return { orch, platform, conn };
}

async function expectThrow(fn: () => Promise<unknown>): Promise<RGSError> {
  try { await fn(); throw new Error("expected the round to fail"); }
  catch (e) { return e as RGSError; }
}

describe("Fail Closed (Guarantee 5) — bad math values never pay", () => {
  test("a NaN multiplier fails the round; no money moves", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: NaN, ops: [], type: "win" })));
    await orch.init({ sid: "nan" }, conn);
    await expectThrow(() => orch.spin({ betIndex: 0 }, conn));
    expect(platform.balance).toBe(platform.start);  // untouched
    expect(platform.settles.length).toBe(0);
  });

  test("an Infinity multiplier fails the round; no money moves", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: Infinity, ops: [], type: "win" })));
    await orch.init({ sid: "inf" }, conn);
    await expectThrow(() => orch.spin({ betIndex: 0 }, conn));
    expect(platform.balance).toBe(platform.start);
  });

  test("a negative multiplier is clamped to 0 (a loss), never a negative settle", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: -5, ops: [], type: "win" })));
    await orch.init({ sid: "neg" }, conn);
    const r = await orch.spin({ betIndex: 0 }, conn);
    expect(r.win).toBe(0);                            // clamped, not -500
    expect(platform.balance).toBe(platform.start - 100);  // only the bet was taken
  });
});

describe("No Money, No Honey (Guarantee 1) — a rejected settle moves nothing", () => {
  test("wallet throwing on settle → round fails, balance unchanged", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: 2, ops: [], type: "win" })));
    platform.fault = "settle-throws";
    await orch.init({ sid: "throw" }, conn);
    const e = await expectThrow(() => orch.spin({ betIndex: 0 }, conn));
    expect(e).toBeInstanceOf(RGSError);
    expect(platform.balance).toBe(platform.start);   // no debit, no credit
    expect(platform.settles.length).toBe(0);
  });

  test("wallet rejecting for insufficient funds → mapped error, no money moved", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: 0, ops: [], type: "loss" })));
    platform.fault = "settle-insufficient";
    await orch.init({ sid: "insuf" }, conn);
    const e = await expectThrow(() => orch.spin({ betIndex: 0 }, conn));
    expect(e.code).toBe("INSUFFICIENT_BALANCE");
    expect(platform.balance).toBe(platform.start);
  });
});

describe("Bounded Payout (Guarantee 7) — a runaway multiplier is capped", () => {
  test("a 10,000x win against a 1,000x cap pays exactly the cap", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: 10_000, ops: [], type: "win" })), 1000);
    await orch.init({ sid: "cap" }, conn);
    const r = await orch.spin({ betIndex: 0 }, conn);
    expect(r.multiplier).toBe(1000);                 // clipped to cap
    expect(r.type).toBe("max_win_reached");
    expect(r.win).toBe(100 * 1000);                  // cap x bet, not 10000 x bet
    expect(platform.balance).toBe(platform.start - 100 + 100_000);
  });
});

describe("Conservation under a faulty session — money is never created", () => {
  test("alternating good spins and wallet faults keeps the ledger exact", async () => {
    const { orch, platform, conn } = setup(math(() => ({ multiplier: 2, ops: [], type: "win" })));
    await orch.init({ sid: "mix" }, conn);
    let expected = platform.start;
    for (let i = 0; i < 50; i++) {
      platform.fault = i % 3 === 0 ? "settle-throws" : "none";
      try {
        await orch.spin({ betIndex: 0 }, conn);
        if (platform.fault === "none") expected += -100 + 200;  // a good 2x spin nets +100
      } catch { /* faulted spin moves nothing */ }
    }
    // Ledger identity: final balance equals start + sum of net moves the wallet
    // actually applied (faulted spins contributed nothing).
    expect(platform.balance).toBe(expected);
    expect(platform.balance).toBe(platform.start + platform.settles.reduce((a, b) => a + b, 0));
  });
});
