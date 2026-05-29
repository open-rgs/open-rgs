// Smoke: run conformance against a known-good adapter (MockPlatform-like
// hand-rolled inside this file so we don't drag platform-mock as a
// devDependency just for this test).

import { describe, expect, test } from "bun:test";
import type { PlatformAdapter, PlatformEvent, SessionInfo, SettleSimple, OpenComplex, CloseComplex, RoundReceipt } from "@open-rgs/contract";
import { runConformance, mdConformanceReport } from "../src/index.js";

// A genuinely SAFE reference adapter: dedupes idempotency keys, rejects
// overspend / unknown session / bad round id. The conformance kit now has
// teeth (H13), so "known-good" must actually be good.
class TinyAdapter implements PlatformAdapter {
  private connected = false;
  private balance = 10_000;
  private nextRoundId = 1;
  private handlers: ((e: PlatformEvent) => void)[] = [];
  private openRoundId: string | undefined;
  private sessions = new Set<string>();
  private receipts = new Map<string, RoundReceipt>();

  async connect()    { this.connected = true; }
  disconnect()       { this.connected = false; }
  get isHealthy()    { return this.connected; }
  get diagnostics()  { return { adapter: "tiny", version: "0.0.1", balance: this.balance }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handlers.push(h); }
  private emit(e: PlatformEvent) { for (const h of this.handlers) h(e); }
  private replay(k?: string) { return k !== undefined ? this.receipts.get(k) : undefined; }
  private remember(k: string | undefined, r: RoundReceipt) { if (k !== undefined) this.receipts.set(k, r); return r; }
  private assertSession(id: string) { if (!this.sessions.has(id)) throw new Error(`SessionInvalid: ${id}`); }

  async openSession(sessionId: string): Promise<SessionInfo> {
    this.sessions.add(sessionId);
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
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    this.assertSession(req.sessionId);
    if (req.bet > this.balance) throw new Error("InsufficientFunds");
    this.balance = this.balance - req.bet + req.win;
    const roundId = `r-${this.nextRoundId++}`;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "spin" });
    return this.remember(req.idempotencyKey, { roundId, balance: this.balance });
  }

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    this.assertSession(req.sessionId);
    if (req.bet > this.balance) throw new Error("InsufficientFunds");
    this.balance -= req.bet;
    const roundId = `r-${this.nextRoundId++}`;
    this.openRoundId = roundId;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "open" });
    return this.remember(req.idempotencyKey, { roundId, balance: this.balance });
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    this.assertSession(req.sessionId);
    if (this.openRoundId !== req.roundId) throw new Error("round mismatch");
    this.balance += req.win;
    this.openRoundId = undefined;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "close" });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: this.balance });
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

// Unsafe adapter: moves money on every call (no dedupe), no overspend or
// session checks. The kit MUST flag it — this is what the audit said it
// failed to do (it shipped green for adapters like this).
class NaiveAdapter implements PlatformAdapter {
  private connected = false;
  private balance = 10_000;
  private n = 1;
  private handlers: ((e: PlatformEvent) => void)[] = [];
  async connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  get isHealthy() { return this.connected; }
  get diagnostics() { return { adapter: "naive", version: "0.0.1" }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handlers.push(h); }
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [10, 50, 100, 500], defaultBetIndex: 2 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.balance = this.balance - req.bet + req.win; // no dedupe, no overspend/session check
    for (const h of this.handlers) h({ type: "balanceChanged", sessionId: req.sessionId, balance: this.balance, reason: "spin" });
    return { roundId: `r-${this.n++}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r-${this.n++}`, balance: this.balance }; }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
}

describe("runConformance has teeth (H13)", () => {
  test("an adapter that doesn't dedupe / reject overspend / reject unknown session is FLAGGED", async () => {
    const r = await runConformance(new NaiveAdapter(), { skipComplex: true, skipEvents: true });
    const fail = (id: string) => r.checks.find(c => c.id === id)?.status;
    expect(fail("idempotency.duplicate-key")).toBe("fail"); // money moved twice
    expect(fail("errors.insufficient-funds")).toBe("fail"); // overspend accepted
    expect(fail("errors.unknown-session")).toBe("fail");    // settle on unopened session accepted
    expect(r.summary.fail).toBeGreaterThanOrEqual(3);
  });
});

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
