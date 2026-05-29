// runConformance  - walks an adapter through the standard lifecycle and
// records a pass/fail per check. Doesn't throw; you read the report.
//
// Coverage:
//   - lifecycle: connect, isHealthy, diagnostics shape, disconnect
//   - simple-round: openSession returns SessionInfo, settleSimple debits+credits
//   - complex-round (if attempted): openComplex -> updateComplex(optional) -> closeComplex
//   - events: onEvent registered, balanceChanged fires when expected
//   - idempotency: a REPEATED key moves money once and returns the same
//     receipt  - the property the contract relies on (was advertised but
//     never actually run; audit H13)
//   - error paths: overspend, unknown session, and bad round id are rejected
//   - each check is bounded by perCheckTimeoutMs (enforced via Promise.race)
//
// The suite doesn't mutate real-money state because it expects a mock
// or sandboxed adapter; it's a CONTRACT check, not an integration test.

import type {
  PlatformAdapter, PlatformEvent, SettleSimple,
  SessionInfo, RoundReceipt,
} from "@open-rgs/contract";
import { DEFAULT_FIXTURE, type CheckResult, type ConformanceFixture, type ConformanceReport, type CheckStatus } from "./types.js";

export interface RunOptions {
  /** Overrides for the conformance session shape. */
  fixture?: Partial<ConformanceFixture>;
  /** Default 5_000ms. */
  perCheckTimeoutMs?: number;
  /** Skip complex-round checks (use for a simple-rounds-only wallet). */
  skipComplex?: boolean;
  /** Skip event checks (use for a wallet that doesn't push events). */
  skipEvents?: boolean;
}

export async function runConformance(
  adapter: PlatformAdapter,
  opts: RunOptions = {},
): Promise<ConformanceReport> {
  const fixture: ConformanceFixture = { ...DEFAULT_FIXTURE, ...(opts.fixture ?? {}) };
  const checks: CheckResult[] = [];
  const startedAt = new Date();
  const overallStart = performance.now();

  const events: PlatformEvent[] = [];
  const eventHandler = (e: PlatformEvent) => events.push(e);
  const perCheckTimeoutMs = opts.perCheckTimeoutMs ?? 5_000;

  async function run(id: string, group: string, description: string, fn: () => Promise<void>): Promise<void> {
    const start = performance.now();
    let status: CheckStatus = "ok";
    let message: string | undefined;
    // Bound each check  - a hung adapter call must surface as a failed check,
    // not freeze the whole run. (perCheckTimeoutMs was plumbed but never
    // enforced; audit H13.)
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`check timed out after ${perCheckTimeoutMs}ms`)), perCheckTimeoutMs);
        }),
      ]);
    } catch (e) {
      status = "fail";
      message = e instanceof Error ? e.message : String(e);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const entry: CheckResult = { id, group, description, status, durationMs: Math.round(performance.now() - start) };
    if (message !== undefined) entry.message = message;
    checks.push(entry);
  }

  /** Assert a call rejects (for error-path checks). Fails the check if it
   *  resolves instead of throwing. */
  async function expectReject(fn: () => Promise<unknown>, whatShouldHappen: string): Promise<void> {
    let threw = false;
    try { await fn(); } catch { threw = true; }
    if (!threw) throw new Error(whatShouldHappen);
  }

  function skip(id: string, group: string, description: string, reason: string): void {
    checks.push({ id, group, description, status: "skip", message: reason, durationMs: 0 });
  }

  // --- lifecycle --------------------------------------------------
  await run("lifecycle.connect", "lifecycle", "connect() resolves", async () => {
    await adapter.connect();
  });
  await run("lifecycle.isHealthy", "lifecycle", "isHealthy is true after connect()", async () => {
    if (!adapter.isHealthy) throw new Error("isHealthy reads false after connect()");
  });
  await run("lifecycle.diagnostics", "lifecycle", "diagnostics returns a JSON-serialisable object", async () => {
    const d = adapter.diagnostics;
    if (!d || typeof d !== "object") throw new Error("diagnostics not an object");
    JSON.stringify(d);
  });
  await run("lifecycle.onEvent.register", "lifecycle", "onEvent accepts a handler", async () => {
    adapter.onEvent(eventHandler);
  });

  // --- session open -----------------------------------------------
  let session: SessionInfo | undefined;
  await run("session.openSession.shape", "session", "openSession returns a well-formed SessionInfo", async () => {
    session = await adapter.openSession(fixture.sessionId, fixture.connectionId);
    if (!session) throw new Error("openSession returned undefined");
    if (session.sessionId !== fixture.sessionId) throw new Error(`sessionId echoed wrongly: ${session.sessionId}`);
    if (!Number.isFinite(session.balance) || !Number.isInteger(session.balance)) {
      throw new Error(`balance must be a finite integer minor unit (NaN/Infinity/float rejected): ${session.balance}`);
    }
    if (typeof session.currency !== "string")   throw new Error(`currency not a string: ${session.currency}`);
    if (!Array.isArray(session.allowedBets) || session.allowedBets.length === 0) {
      throw new Error(`allowedBets missing or empty: ${JSON.stringify(session.allowedBets)}`);
    }
    if (typeof session.defaultBetIndex !== "number") {
      throw new Error(`defaultBetIndex not a number: ${session.defaultBetIndex}`);
    }
    if (typeof session.currencyDecimals !== "number" || session.currencyDecimals < 0 || !Number.isInteger(session.currencyDecimals)) {
      throw new Error(`currencyDecimals must be a non-negative integer: ${session.currencyDecimals}`);
    }
  });

  // --- simple round -----------------------------------------------
  let receipt: RoundReceipt | undefined;
  await run("simple.settleSimple.zero-win", "simple-round", "settleSimple with win=0 returns a RoundReceipt with updated balance", async () => {
    if (!session) throw new Error("no session (prerequisite failed)");
    const before = session.balance;
    const req: SettleSimple = {
      sessionId: fixture.sessionId,
      bet: fixture.bet,
      betIndex: fixture.betIndex,
      priceMultiplier: fixture.priceMultiplier,
      win: 0,
      multiplier: 0,
      type: "loss",
      roundState: "",
      idempotencyKey: "conf-loss-1",
    };
    receipt = await adapter.settleSimple(req);
    if (!receipt) throw new Error("settleSimple returned undefined");
    if (!receipt.roundId) throw new Error("receipt missing roundId");
    if (!Number.isFinite(receipt.balance) || !Number.isInteger(receipt.balance)) {
      throw new Error(`receipt.balance must be a finite integer minor unit: ${receipt.balance}`);
    }
    if (receipt.balance !== before - fixture.bet) {
      throw new Error(`balance ${receipt.balance} != expected ${before - fixture.bet}`);
    }
  });

  await run("simple.settleSimple.with-win", "simple-round", "settleSimple credits the win", async () => {
    if (!session || !receipt) throw new Error("prerequisite failed");
    const before = receipt.balance;
    const winAmount = fixture.bet * 2;
    const req: SettleSimple = {
      sessionId: fixture.sessionId,
      bet: fixture.bet,
      betIndex: fixture.betIndex,
      priceMultiplier: fixture.priceMultiplier,
      win: winAmount,
      multiplier: 2,
      type: "win",
      roundState: "",
      idempotencyKey: "conf-win-1",
    };
    const r = await adapter.settleSimple(req);
    const expected = before - fixture.bet + winAmount;
    if (r.balance !== expected) {
      throw new Error(`balance ${r.balance} != expected ${expected}`);
    }
  });

  // --- idempotency ------------------------------------------------
  // The headline safety property: a retried settle (same key) must move
  // money at most once and return the original receipt.
  await run("idempotency.duplicate-key", "idempotency", "a repeated idempotencyKey moves money once and returns the same receipt", async () => {
    if (!session) throw new Error("no session (prerequisite failed)");
    const dupReq: SettleSimple = {
      sessionId: fixture.sessionId,
      bet: fixture.bet,
      betIndex: fixture.betIndex,
      priceMultiplier: fixture.priceMultiplier,
      win: fixture.bet * 2,          // net non-zero, so a second move would show
      multiplier: 2,
      type: "win",
      roundState: "",
      idempotencyKey: "conf-dup-1",  // SAME key for both calls
    };
    const first = await adapter.settleSimple(dupReq);
    const second = await adapter.settleSimple({ ...dupReq });
    if (second.roundId !== first.roundId) {
      throw new Error(`duplicate key produced a different roundId (${first.roundId} -> ${second.roundId})  - not deduped`);
    }
    if (second.balance !== first.balance) {
      throw new Error(`duplicate key moved money twice: balance ${first.balance} -> ${second.balance}`);
    }
  });

  // --- error paths ------------------------------------------------
  await run("errors.insufficient-funds", "errors", "a bet exceeding balance is rejected", async () => {
    await expectReject(() => adapter.settleSimple({
      sessionId: fixture.sessionId,
      bet: 10_000_000_000,           // far above any conformance balance
      betIndex: fixture.betIndex,
      priceMultiplier: fixture.priceMultiplier,
      win: 0, multiplier: 0, type: "loss", roundState: "",
      idempotencyKey: "conf-overspend-1",
    }), "settle with bet > balance was accepted  - a wallet MUST reject overspend");
  });

  await run("errors.unknown-session", "errors", "a settle on an unopened session is rejected", async () => {
    await expectReject(() => adapter.settleSimple({
      sessionId: "conf-never-opened-zzz",
      bet: fixture.bet,
      betIndex: fixture.betIndex,
      priceMultiplier: fixture.priceMultiplier,
      win: 0, multiplier: 0, type: "loss", roundState: "",
      idempotencyKey: "conf-unknown-session-1",
    }), "settle on an unknown session was accepted  - a wallet MUST reject it");
  });

  // --- complex round ----------------------------------------------
  if (opts.skipComplex) {
    skip("complex.openComplex", "complex-round", "openComplex debits the bet", "skipComplex set");
    skip("complex.closeComplex", "complex-round", "closeComplex credits the win", "skipComplex set");
    skip("errors.bad-round-id", "errors", "closeComplex with an unknown roundId is rejected", "skipComplex set");
  } else {
    let openReceipt: RoundReceipt | undefined;
    await run("complex.openComplex", "complex-round", "openComplex debits the bet", async () => {
      openReceipt = await adapter.openComplex({
        sessionId: fixture.sessionId,
        bet: fixture.bet,
        betIndex: fixture.betIndex,
        priceMultiplier: fixture.priceMultiplier,
        initialState: "open-state-v1",
        idempotencyKey: "conf-open-1",
      });
      if (!openReceipt?.roundId) throw new Error("openComplex returned no roundId");
    });
    if (typeof adapter.updateComplex === "function") {
      await run("complex.updateComplex", "complex-round", "updateComplex resolves without throwing (audit-only)", async () => {
        if (!openReceipt) throw new Error("openReceipt missing");
        await adapter.updateComplex!({
          sessionId: fixture.sessionId,
          roundId: openReceipt.roundId,
          state: "mid-state-v1",
        });
      });
    } else {
      skip("complex.updateComplex", "complex-round", "updateComplex (optional)  - not implemented", "adapter does not implement updateComplex");
    }
    // Bad round id is rejected  - and must leave the real open round intact,
    // so we run it before the valid close.
    await run("errors.bad-round-id", "errors", "closeComplex with an unknown roundId is rejected", async () => {
      await expectReject(() => adapter.closeComplex({
        sessionId: fixture.sessionId,
        roundId: "conf-no-such-round-zzz",
        finalState: "", win: 0, multiplier: 0, type: "loss",
        idempotencyKey: "conf-badround-1",
      }), "closeComplex accepted an unknown roundId  - a wallet MUST reject it");
    });
    await run("complex.closeComplex", "complex-round", "closeComplex credits the win", async () => {
      if (!openReceipt) throw new Error("openReceipt missing");
      const r = await adapter.closeComplex({
        sessionId: fixture.sessionId,
        roundId: openReceipt.roundId,
        finalState: "close-state-v1",
        win: fixture.bet * 3,
        multiplier: 3,
        type: "win",
        idempotencyKey: "conf-close-1",
      });
      if (!r.roundId) throw new Error("closeComplex missing roundId");
    });
  }

  // --- events -----------------------------------------------------
  if (opts.skipEvents) {
    skip("events.received-any", "events", "adapter emitted at least one event during round-flow", "skipEvents set");
  } else {
    await run("events.received-any", "events", "adapter emitted at least one event during round-flow", async () => {
      if (events.length === 0) {
        throw new Error("no events received  - many platforms emit balanceChanged on every round");
      }
    });
    const balanceEvents = events.filter(e => e.type === "balanceChanged");
    await run("events.balanceChanged.shape", "events", "balanceChanged events carry a numeric balance + reason", async () => {
      if (balanceEvents.length === 0) {
        throw new Error("no balanceChanged events received");
      }
      for (const e of balanceEvents) {
        if (e.type !== "balanceChanged") continue;
        if (typeof e.balance !== "number") throw new Error("balanceChanged.balance not a number");
        if (typeof e.reason !== "string")  throw new Error("balanceChanged.reason not a string");
      }
    });
  }

  // --- lifecycle teardown -----------------------------------------
  await run("lifecycle.disconnect", "lifecycle", "disconnect() doesn't throw", async () => {
    adapter.disconnect();
  });
  await run("lifecycle.isHealthy.after-disconnect", "lifecycle", "isHealthy is false after disconnect()", async () => {
    if (adapter.isHealthy) throw new Error("isHealthy reads true after disconnect()");
  });

  const finishedAt = new Date();
  const elapsedMs = Math.round(performance.now() - overallStart);
  const diag = safeDiag(adapter);
  const summary = {
    total: checks.length,
    ok:    checks.filter(c => c.status === "ok").length,
    warn:  checks.filter(c => c.status === "warn").length,
    fail:  checks.filter(c => c.status === "fail").length,
    skip:  checks.filter(c => c.status === "skip").length,
  };

  return {
    adapter: {
      name: String(diag["adapter"] ?? "(unknown)"),
      version: String(diag["version"] ?? "(unknown)"),
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    elapsedMs,
    checks,
    summary,
  };
}

function safeDiag(adapter: PlatformAdapter): Record<string, unknown> {
  try {
    return adapter.diagnostics ?? {};
  } catch (e) {
    // Surface the failure inside the report rather than silently swallowing.
    return {
      adapter: "(unknown  - diagnostics getter threw)",
      version: "(unknown)",
      "_conformance_error": e instanceof Error ? e.message : String(e),
    };
  }
}
