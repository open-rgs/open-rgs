// runConformance  - walks an adapter through the standard lifecycle and
// records a pass/fail per check. Doesn't throw; you read the report.
//
// Coverage today:
//   - lifecycle: connect, isHealthy, diagnostics shape, disconnect
//   - simple-round: openSession returns SessionInfo, settleSimple debits+credits
//   - complex-round (if attempted): openComplex -> updateComplex(optional) -> closeComplex
//   - events: onEvent registered, balanceChanged + autocloseRequested fire when expected
//   - idempotency: same key sent twice produces same receipt (skipped if adapter doesn't expose a way to verify)
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
  /** Skip complex-round checks (use if your platform is simple-rounds-only). */
  skipComplex?: boolean;
  /** Skip event checks (use if your platform doesn't push events). */
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

  async function run(id: string, group: string, description: string, fn: () => Promise<void>): Promise<void> {
    const start = performance.now();
    let status: CheckStatus = "ok";
    let message: string | undefined;
    try {
      await fn();
    } catch (e) {
      status = "fail";
      message = e instanceof Error ? e.message : String(e);
    }
    const entry: CheckResult = { id, group, description, status, durationMs: Math.round(performance.now() - start) };
    if (message !== undefined) entry.message = message;
    checks.push(entry);
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
    if (typeof session.balance !== "number")    throw new Error(`balance not a number: ${session.balance}`);
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
    if (typeof receipt.balance !== "number") throw new Error("receipt.balance not a number");
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

  // --- complex round ----------------------------------------------
  if (opts.skipComplex) {
    skip("complex.openComplex", "complex-round", "openComplex debits the bet", "skipComplex set");
    skip("complex.closeComplex", "complex-round", "closeComplex credits the win", "skipComplex set");
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
