// Smoke: run conformance against a known-good adapter (MockPlatform-like
// hand-rolled inside this file so we don't drag platform-mock as a
// devDependency just for this test).

import { describe, expect, test } from "bun:test";
import type { PlatformAdapter, PlatformEvent, SessionInfo, SettleSimple, OpenComplex, CloseComplex, RoundReceipt } from "@open-rgs/contract";
import { runConformance, mdConformanceReport } from "../src/index.js";

class TinyAdapter implements PlatformAdapter {
  private connected = false;
  private balance = 10_000;
  private nextRoundId = 1;
  private handlers: ((e: PlatformEvent) => void)[] = [];
  private openRoundId: string | undefined;

  async connect()    { this.connected = true; }
  disconnect()       { this.connected = false; }
  get isHealthy()    { return this.connected; }
  get diagnostics()  { return { adapter: "tiny", version: "0.0.1", balance: this.balance }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handlers.push(h); }
  private emit(e: PlatformEvent) { for (const h of this.handlers) h(e); }

  async openSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId,
      currency: "USD",
      currencyDecimals: 2,
      balance: this.balance,
      allowedBets: [10, 50, 100, 500],
      defaultBetIndex: 2,
    };
  }

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.balance = this.balance - req.bet + req.win;
    const roundId = `r-${this.nextRoundId++}`;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "spin" });
    return { roundId, balance: this.balance };
  }

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.balance -= req.bet;
    const roundId = `r-${this.nextRoundId++}`;
    this.openRoundId = roundId;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "open" });
    return { roundId, balance: this.balance };
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    if (this.openRoundId !== req.roundId) throw new Error("round mismatch");
    this.balance += req.win;
    this.openRoundId = undefined;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "close" });
    return { roundId: req.roundId, balance: this.balance };
  }
}

class BrokenAdapter implements PlatformAdapter {
  async connect() { /* never marks healthy */ }
  disconnect() {}
  get isHealthy() { return false; }
  get diagnostics() { return { adapter: "broken", version: "0" }; }
  onEvent() { /* discards */ }
  async openSession(): Promise<SessionInfo> {
    return {
      sessionId: "x",
      currency: "X",
      currencyDecimals: 2,
      balance: NaN as unknown as number,
      allowedBets: [] as number[],
      defaultBetIndex: 0,
    };
  }
  async settleSimple(): Promise<RoundReceipt> { return { roundId: "", balance: 0 }; }
  async openComplex(): Promise<RoundReceipt> { return { roundId: "", balance: 0 }; }
  async closeComplex(): Promise<RoundReceipt> { return { roundId: "", balance: 0 }; }
}

describe("runConformance", () => {
  test("known-good adapter passes everything that's not skipped", async () => {
    const adapter = new TinyAdapter();
    const r = await runConformance(adapter);
    expect(r.summary.fail).toBe(0);
    // updateComplex is optional and our tiny adapter doesn't implement it.
    expect(r.summary.skip).toBeGreaterThan(0);
    expect(r.adapter.name).toBe("tiny");
    expect(r.checks.find(c => c.id === "lifecycle.connect")?.status).toBe("ok");
    expect(r.checks.find(c => c.id === "simple.settleSimple.zero-win")?.status).toBe("ok");
    expect(r.checks.find(c => c.id === "events.balanceChanged.shape")?.status).toBe("ok");
  });

  test("broken adapter surfaces a list of failures, not exceptions", async () => {
    const adapter = new BrokenAdapter();
    const r = await runConformance(adapter);
    expect(r.summary.fail).toBeGreaterThan(0);
    const healthy = r.checks.find(c => c.id === "lifecycle.isHealthy");
    expect(healthy?.status).toBe("fail");
    const shape = r.checks.find(c => c.id === "session.openSession.shape");
    expect(shape?.status).toBe("fail");
  });

  test("skipComplex / skipEvents create skip entries", async () => {
    const r = await runConformance(new TinyAdapter(), { skipComplex: true, skipEvents: true });
    const skipped = r.checks.filter(c => c.status === "skip").map(c => c.id);
    expect(skipped).toContain("complex.openComplex");
    expect(skipped).toContain("complex.closeComplex");
    expect(skipped).toContain("events.received-any");
  });

  test("mdConformanceReport renders a usable markdown blob", async () => {
    const r = await runConformance(new TinyAdapter());
    const md = mdConformanceReport(r);
    expect(md).toContain("# Conformance — tiny @ 0.0.1");
    expect(md).toContain("## lifecycle");
    expect(md).toContain("## simple-round");
    expect(md).toMatch(/✓ ok/);
  });

  test("fixture override changes the bet shape", async () => {
    const r = await runConformance(new TinyAdapter(), {
      fixture: { bet: 250, betIndex: 3 },
    });
    expect(r.summary.fail).toBe(0);
  });
});
