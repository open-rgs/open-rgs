// H4  - a 0-stake (free-round) mode that returns a winning multiplier would
// settle win = multiplier x 0 = 0, silently losing the player's payout. The
// orchestrator now forbids it (a win must be funded).

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type RoundReceipt,
  type SimpleMath, type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class MiniPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 10_000;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    // Real platforms derive the debit from (bet x priceMultiplier),
    // where priceMultiplier now carries the mode's stakeMultiplier
    // (see orchestrator computeBet). Mirror that here so a
    // stakeMultiplier=0 free-round mode actually debits 0.
    const cost = req.bet * (req.priceMultiplier ?? 1);
    this.balance = this.balance - cost + req.win;
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
  async closeComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const win5: SimpleMath = { kind: "simple", name: "w", version: "1", rtp: 1, play: () => ({ multiplier: 5, ops: [], type: "win" }) };
const loss: SimpleMath = { kind: "simple", name: "l", version: "1", rtp: 0, play: () => ({ multiplier: 0, ops: [], type: "loss" }) };

function setup() {
  const platform = new MiniPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: {
      base:    { math: win5, stakeMultiplier: 1 },          // normal paid mode
      "fs-win":  { math: win5, stakeMultiplier: 0 },        // free mode that "wins" (unfundable)
      "fs-loss": { math: loss, stakeMultiplier: 0 },        // free mode that loses (fine)
    },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, conn };
}

describe("free-spin funding (H4)", () => {
  test("a 0-bet round with a winning multiplier is rejected (not silently 0)", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "h4-win" }, conn);
    let err: unknown;
    try { await orch.spin({ mode: "fs-win" }, conn); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(RGSError);
    expect((err as RGSError).code).toBe("INVALID_BET");
  });

  test("a 0-bet losing round is fine (free spin that didn't win)", async () => {
    const { orch, conn } = setup();
    const init = await orch.init({ sid: "h4-loss" }, conn);
    const balBefore = init.balance;
    const r = await orch.spin({ mode: "fs-loss" }, conn);
    // Wire `bet` is base x priceMultiplier (no stake fold) -> 100 even
    // for a stakeMultiplier=0 free-round mode. The actual debit is
    // bet x stakeMultiplier = 0  - verified via the unchanged balance
    // below  - and the platform sees priceMultiplier x stake = 0 so
    // its ledger records the free-round nature too.
    expect(r.bet).toBe(100);
    expect(r.win).toBe(0);
    expect(r.balance).toBe(balBefore);
  });

  test("a normally-staked winning round is unaffected", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "h4-base" }, conn);
    const r = await orch.spin({ mode: "base", betIndex: 0 }, conn);
    expect(r.bet).toBe(100);
    expect(r.win).toBe(500);
  });
});
