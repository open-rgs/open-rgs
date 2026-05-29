// C4 — per-session operations must serialize. Each money op awaits the
// math and the wallet, and an await yields the loop, so without a lock two
// ops on one session interleave: two spins both pass the balance check
// against a stale balance (overspend), and a client close races an
// autoclose (double credit). The platform here deliberately delays inside
// each RPC to widen the race window; with the lock the invariants hold
// regardless of timing.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple,
  type OpenComplex, type CloseComplex, type RoundReceipt,
  type SimpleMath, type ComplexMath, type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class SlowPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance: number;
  settleCount = 0;
  closeCount = 0;
  private seq = 0;
  constructor(balance: number) { this.balance = balance; }
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId, currency: "USD", currencyDecimals: 2,
      balance: this.balance, allowedBets: [10, 100], defaultBetIndex: 1,
    };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    await delay(15);
    this.settleCount++;
    this.balance = this.balance - req.bet + req.win;
    return { roundId: `r${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    await delay(5);
    this.balance -= req.bet;
    return { roundId: `r${++this.seq}`, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    await delay(15);
    this.closeCount++;
    this.balance += req.win;
    return { roundId: req.roundId, balance: this.balance };
  }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const lossMath: SimpleMath = {
  kind: "simple", name: "loss", version: "1", rtp: 0,
  play: () => ({ multiplier: 0, ops: [], type: "loss" }),
};
const complexMath: ComplexMath = {
  kind: "complex", name: "cx", version: "1", rtp: 1,
  open: () => ({ state: { open: true }, ops: [] }),
  step: (state) => ({ state, ops: [] }),
  isTerminal: () => true,
  close: () => ({ multiplier: 2, ops: [], type: "win" }),
};

function makeOrchestrator(balance: number) {
  const platform = new SlowPlatform(balance);
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: {
      base: { math: lossMath, stakeMultiplier: 1 },
      cx: { math: complexMath, stakeMultiplier: 1 },
    },
  });
  const orch = createOrchestrator({ manifest, platform, isDev: false });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}

describe("per-session locking (C4)", () => {
  test("concurrent spins cannot overspend — one settles, one is rejected", async () => {
    // balance 150, two bets of 100 (both losses). Together they'd overspend
    // to -50; serialized, the second must hit INSUFFICIENT_BALANCE.
    const { orch, platform, conn } = makeOrchestrator(150);
    await orch.init({ sid: "lk-spin" }, conn);

    const results = await Promise.allSettled([
      orch.spin({ betIndex: 1 }, conn),
      orch.spin({ betIndex: 1 }, conn),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(platform.settleCount).toBe(1);   // only one debit reached the wallet
    expect(platform.balance).toBe(50);      // 150 - 100, never -50
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/INSUFFICIENT_BALANCE|balance/);
  });

  test("a client close racing an autoclose credits exactly once", async () => {
    const { orch, platform, conn } = makeOrchestrator(10_000);
    await orch.init({ sid: "lk-race" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);

    // Fire both close paths in the same tick — the lock serializes them and
    // the loser finds no open round.
    const [clientClose, auto] = await Promise.allSettled([
      orch.closeRound({}, conn),
      orch.autocloseRound({ sessionId: "lk-race", roundId: opened.roundId, reason: "race" }),
    ]);

    expect(platform.closeCount).toBe(1); // exactly one credit
    // One path settled the round; the other observed it already gone.
    const closedOk =
      (clientClose.status === "fulfilled") ||
      (auto.status === "fulfilled" && (auto.value as { closed: boolean }).closed);
    expect(closedOk).toBe(true);
  });

  test("sequential operations still work normally under the lock", async () => {
    const { orch, platform, conn } = makeOrchestrator(10_000);
    await orch.init({ sid: "lk-seq" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    const closed = await orch.closeRound({}, conn);
    expect(closed.roundId).toBe(opened.roundId);
    expect(closed.win).toBe(200); // 2x * 100
    expect(platform.closeCount).toBe(1);
  });
});
