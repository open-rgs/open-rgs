// Financial counters: in-process, monotonic, per {currency, mode, funding}.
// GGR and RTP are derived at query time from these - the server itself only
// increments. These tests drive the real orchestrator and read the counters
// back through both surfaces: Prometheus exposition and Counter.snapshot()
// (the in-memory read the financial snapshot log uses).

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import { createRgsMetrics } from "../src/metrics-rgs.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath,
  type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class Wallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.balance += -req.bet + req.win;
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r${++this.seq}`, balance: this.balance }; }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const half: SimpleMath = {
  kind: "simple", name: "half", version: "1", rtp: 0.5,
  play: () => ({ multiplier: 0.5, ops: [], type: "win" }),
};

function setup() {
  const platform = new Wallet();
  const metrics = createRgsMetrics();
  const manifest = defineGame({
    id: "g", declaredRtp: 0.5, defaultMode: "base", maxWinMultiplier: 1000,
    modes: { base: { math: half, stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform, metrics });
  const conn: ConnectionMeta = { connectionId: "c", sessionId: null, demo: false };
  return { orch, metrics, conn };
}

describe("financial counters (bets/wins minor units)", () => {
  test("a settled spin increments bets and wins with funding=real", async () => {
    const { orch, metrics, conn } = setup();
    await orch.init({ sid: "fin" }, conn);
    await orch.spin({ betIndex: 0 }, conn);   // bet 100, win 50 (0.5x)
    await orch.spin({ betIndex: 0 }, conn);

    const text = metrics.registry.expose();
    expect(text).toContain('rgs_bets_minor_total{currency="USD",mode="base",funding="real"} 200');
    expect(text).toContain('rgs_wins_minor_total{currency="USD",mode="base",funding="real"} 100');
  });

  test("snapshot() exposes the same totals for the in-process financial log", async () => {
    const { orch, metrics, conn } = setup();
    await orch.init({ sid: "fin2" }, conn);
    await orch.spin({ betIndex: 0 }, conn);

    const bets = metrics.betsMinor.snapshot();
    expect(bets).toEqual([{ labels: 'currency="USD",mode="base",funding="real"', value: 100 }]);
    const wins = metrics.winsMinor.snapshot();
    expect(wins).toEqual([{ labels: 'currency="USD",mode="base",funding="real"', value: 50 }]);
  });

  test("zero-win rounds increment bets only", async () => {
    const loss: SimpleMath = { kind: "simple", name: "loss", version: "1", rtp: 0, play: () => ({ multiplier: 0, ops: [], type: "loss" }) };
    const metrics = createRgsMetrics();
    const manifest = defineGame({ id: "g2", declaredRtp: 0, defaultMode: "base", maxWinMultiplier: 1000, modes: { base: { math: loss, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform: new Wallet(), metrics });
    const conn: ConnectionMeta = { connectionId: "c", sessionId: null, demo: false };
    await orch.init({ sid: "z" }, conn);
    await orch.spin({ betIndex: 0 }, conn);
    const text = metrics.registry.expose();
    expect(text).toContain('rgs_bets_minor_total{currency="USD",mode="base",funding="real"} 100');
    expect(text).toContain("rgs_wins_minor_total 0"); // no win series materialized
  });
});
