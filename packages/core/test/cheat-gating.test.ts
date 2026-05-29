// C9  - a forced-outcome `cheat` must never be honored unless cheats are
// explicitly enabled, and must not be a first-class wire field. These tests
// pin: the orchestrator ignores params.cheat by default (cheatsEnabled
// false), honors it only when enabled, and that the math sees ctx.cheat
// solely via the gated path.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type RoundReceipt,
  type SimpleMath, type ConnectionMeta, type PlatformEvent, type CheatHint,
} from "@open-rgs/contract";

let seenCheat: CheatHint | undefined;
const cheatAwareMath: SimpleMath = {
  kind: "simple", name: "c", version: "1", rtp: 1,
  play: (_prev, ctx) => {
    seenCheat = ctx.cheat;
    const m = ctx.cheat?.force_win ? 10 : 0;
    return { multiplier: m, ops: [], type: m > 0 ? "win" : "loss" };
  },
};

class MiniPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 10_000;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.balance = this.balance - req.bet + req.win;
    return { roundId: "r1", balance: this.balance };
  }
  async openComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
  async closeComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

function setup(cheatsEnabled: boolean) {
  const platform = new MiniPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: { base: { math: cheatAwareMath, stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform, cheatsEnabled });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, conn };
}

describe("cheat gating (C9)", () => {
  test("cheatsEnabled=false -> params.cheat is ignored (no forced win)", async () => {
    seenCheat = undefined;
    const { orch, conn } = setup(false);
    await orch.init({ sid: "no-cheat" }, conn);
    const spin = await orch.spin({ params: { cheat: { force_win: true } } }, conn);
    expect(seenCheat).toBeUndefined();
    expect(spin.win).toBe(0); // forced win did NOT happen
  });

  test("cheatsEnabled=true -> params.cheat is honored (dev affordance)", async () => {
    seenCheat = undefined;
    const { orch, conn } = setup(true);
    await orch.init({ sid: "yes-cheat" }, conn);
    const spin = await orch.spin({ params: { cheat: { force_win: true } } }, conn);
    expect(seenCheat).toEqual({ force_win: true });
    expect(spin.win).toBe(1000); // 10x * bet 100
  });

  test("default (no cheatsEnabled passed) is off", async () => {
    seenCheat = undefined;
    const platform = new MiniPlatform();
    const manifest = defineGame({
      id: "g", declaredRtp: 1, defaultMode: "base",
      modes: { base: { math: cheatAwareMath, stakeMultiplier: 1 } },
    });
    const orch = createOrchestrator({ manifest, platform }); // no cheatsEnabled
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "default-off" }, conn);
    const spin = await orch.spin({ params: { cheat: { force_win: true } } }, conn);
    expect(seenCheat).toBeUndefined();
    expect(spin.win).toBe(0);
  });
});
