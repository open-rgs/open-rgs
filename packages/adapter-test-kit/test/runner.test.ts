// Smoke: run conformance against a known-good adapter (a tiny hand-rolled
// one for the cheap checks), plus the real reference adapter
// (@open-rgs/platform-mock, a devDependency) for the opt-in concurrency
// certification  - that's the adapter the contract points authors at, so the
// kit and the mock must agree.

import { describe, expect, test } from "bun:test";
import type { PlatformAdapter, PlatformEvent, SessionInfo, SettleSimple, OpenComplex, CloseComplex, RoundReceipt } from "@open-rgs/contract";
import { MockPlatform } from "@open-rgs/platform-mock";
import { runConformance, mdConformanceReport } from "../src/index.js";

// A genuinely SAFE reference adapter: dedupes idempotency keys, rejects
// overspend / unknown session / bad round id. The conformance kit now has
// teeth (H13), so "known-good" must actually be good.
class TinyAdapter implements PlatformAdapter {
  private connected = false;
  private balances = new Map<string, number>();   // per session, like a real wallet
  private nextRoundId = 1;
  private handlers: ((e: PlatformEvent) => void)[] = [];
  private openRoundId: string | undefined;
  private receipts = new Map<string, RoundReceipt>();

  async connect()    { this.connected = true; }
  disconnect()       { this.connected = false; }
  get isHealthy()    { return this.connected; }
  get diagnostics()  { return { adapter: "tiny", version: "0.0.1", sessions: this.balances.size }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handlers.push(h); }
  private emit(e: PlatformEvent) { for (const h of this.handlers) h(e); }
  private replay(k?: string) { return k !== undefined ? this.receipts.get(k) : undefined; }
  private remember(k: string | undefined, r: RoundReceipt) { if (k !== undefined) this.receipts.set(k, r); return r; }
  private mustBalance(id: string): number {
    const b = this.balances.get(id);
    if (b === undefined) throw new Error(`SessionInvalid: ${id}`);
    return b;
  }

  async openSession(sessionId: string): Promise<SessionInfo> {
    if (!this.balances.has(sessionId)) this.balances.set(sessionId, 10_000);
    return {
      sessionId,
      currency: "USD",
      currencyDecimals: 2,
      balance: this.balances.get(sessionId)!,
      allowedBets: [10, 50, 100, 500],
      defaultBetIndex: 2,
    };
  }

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    const bal = this.mustBalance(req.sessionId);
    if (req.bet > bal) throw new Error("InsufficientFunds");
    const next = bal - req.bet + req.win;
    this.balances.set(req.sessionId, next);
    const roundId = `r-${this.nextRoundId++}`;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: next, reason: "spin" });
    return this.remember(req.idempotencyKey, { roundId, balance: next });
  }

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    const bal = this.mustBalance(req.sessionId);
    if (req.bet > bal) throw new Error("InsufficientFunds");
    const next = bal - req.bet;
    this.balances.set(req.sessionId, next);
    const roundId = `r-${this.nextRoundId++}`;
    this.openRoundId = roundId;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: next, reason: "open" });
    return this.remember(req.idempotencyKey, { roundId, balance: next });
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;
    const bal = this.mustBalance(req.sessionId);
    if (this.openRoundId !== req.roundId) throw new Error("round mismatch");
    const next = bal + req.win;
    this.balances.set(req.sessionId, next);
    this.openRoundId = undefined;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: next, reason: "close" });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: next });
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
// session checks. The kit MUST flag it  - this is what the audit said it
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

// Racy adapter: dedupes idempotency keys, but with a read-then-write gap  -
// it checks the receipt map, AWAITS, then records. Sequential retries are
// deduped fine (the old test would pass it); two IN-FLIGHT duplicates both
// pass the read before either writes, and money moves twice. This is the
// race concurrency.duplicate-key-parallel exists to catch.
class RacyAdapter implements PlatformAdapter {
  private connected = false;
  private balances = new Map<string, number>();
  private receipts = new Map<string, RoundReceipt>();
  private n = 1;
  async connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  get isHealthy() { return this.connected; }
  get diagnostics() { return { adapter: "racy", version: "0.0.1" }; }
  onEvent(_h: (e: PlatformEvent) => void) { /* pushes nothing */ }
  async openSession(sessionId: string): Promise<SessionInfo> {
    if (!this.balances.has(sessionId)) this.balances.set(sessionId, 1_000_000);
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balances.get(sessionId)!, allowedBets: [10, 50, 100, 500], defaultBetIndex: 2 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const key = req.idempotencyKey;
    if (key !== undefined) {
      const dup = this.receipts.get(key);
      if (dup) return dup;
    }
    // THE BUG: yield between the dedupe read and the write.
    await new Promise(r => setTimeout(r, 1));
    const bal = this.balances.get(req.sessionId);
    if (bal === undefined) throw new Error(`SessionInvalid: ${req.sessionId}`);
    if (req.bet > bal) throw new Error("InsufficientFunds");
    const next = bal - req.bet + req.win;
    this.balances.set(req.sessionId, next);
    const receipt: RoundReceipt = { roundId: `r-${this.n++}`, balance: next };
    if (key !== undefined) this.receipts.set(key, receipt);
    return receipt;
  }
  async openComplex(): Promise<RoundReceipt> { throw new Error("not exercised (skipComplex)"); }
  async closeComplex(): Promise<RoundReceipt> { throw new Error("not exercised (skipComplex)"); }
}

describe("concurrency certification (opt-in)", () => {
  test("reported as skips unless { concurrency: true }", async () => {
    const r = await runConformance(new TinyAdapter());
    const conc = r.checks.filter(c => c.group === "concurrency");
    expect(conc.map(c => c.id)).toEqual([
      "concurrency.parallel-distinct-settles",
      "concurrency.duplicate-key-parallel",
      "concurrency.reverse-interleave",
      "concurrency.post-storm-settle",
    ]);
    expect(conc.every(c => c.status === "skip")).toBe(true);
  });

  test("reference MockPlatform passes the full suite including concurrency", async () => {
    const r = await runConformance(new MockPlatform(), { concurrency: true });
    expect(r.summary.fail).toBe(0);
    const status = (id: string) => r.checks.find(c => c.id === id)?.status;
    expect(status("concurrency.parallel-distinct-settles")).toBe("ok");
    expect(status("concurrency.duplicate-key-parallel")).toBe("ok");
    // MockPlatform implements reverseRound, so the interleave check RUNS.
    expect(status("concurrency.reverse-interleave")).toBe("ok");
    expect(status("concurrency.post-storm-settle")).toBe("ok");
  });

  test("reverse-interleave skips cleanly when the adapter has no reverseRound", async () => {
    const r = await runConformance(new TinyAdapter(), { concurrency: true });
    expect(r.summary.fail).toBe(0);   // the other three concurrency checks pass
    const rev = r.checks.find(c => c.id === "concurrency.reverse-interleave");
    expect(rev?.status).toBe("skip");
    expect(rev?.message).toContain("reverseRound");
  });

  test("an adapter whose dedupe has a read-then-write race is FLAGGED", async () => {
    const r = await runConformance(new RacyAdapter(), { skipComplex: true, skipEvents: true, concurrency: true });
    const status = (id: string) => r.checks.find(c => c.id === id)?.status;
    // Sequential dedupe looks fine - the duplicate arrives after the write...
    expect(status("idempotency.duplicate-key")).toBe("ok");
    // ...but the in-flight duplicate settles twice.
    expect(status("concurrency.duplicate-key-parallel")).toBe("fail");
    // The race is in the dedupe, not the ledger - distinct keys stay sound.
    expect(status("concurrency.parallel-distinct-settles")).toBe("ok");
    expect(status("concurrency.post-storm-settle")).toBe("ok");
  });
});

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
    expect(md).toContain("# Conformance  - tiny @ 0.0.1");
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
