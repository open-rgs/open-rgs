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
//   - concurrency (opt-in via { concurrency: true }): cross-session parallel
//     settles conserve per-session balances; the SAME idempotencyKey fired
//     twice CONCURRENTLY (in-flight duplicate, not the sequential retry
//     above) settles exactly once; reverseRound stays latest-first under
//     interleaved reversal fire; and a plain settle still reconciles after
//     the storms
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
  /** Opt IN to concurrency certification: parallel cross-session settles,
   *  in-flight duplicate idempotency keys, and reversal interleave. Off by
   *  default (reported as skips, mirroring skipComplex) because it opens
   *  extra derived sessions and assumes each maps to an independent balance
   *  - true for a mock or sandboxed wallet, the only thing this suite
   *  should ever point at. */
  concurrency?: boolean;
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
    // Overspend is driven through priceMultiplier, NOT a giant `bet`:
    // amount-blind wires (the platform recomputes cost from its own bet
    // ladder and ignores the wire amount) never see a doctored `bet`, but
    // EVERY wallet shape sees cost = ladder/bet x priceMultiplier explode
    // past the balance. 1e6 x any conformance ladder entry is far above
    // any conformance balance.
    await expectReject(() => adapter.settleSimple({
      sessionId: fixture.sessionId,
      bet: fixture.bet * 1_000_000,
      betIndex: fixture.betIndex,
      priceMultiplier: 1_000_000,
      win: 0, multiplier: 0, type: "loss", roundState: "",
      idempotencyKey: "conf-overspend-1",
    }), "settle with cost > balance was accepted  - a wallet MUST reject overspend");
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

  // --- concurrency (opt-in) ---------------------------------------
  // The orchestrator serializes client traffic per session, so an adapter
  // never sees two client-driven calls racing on ONE session  - but it DOES
  // see parallel traffic across sessions, retried settles whose duplicate
  // arrives while the original is still in flight, and wallet-initiated
  // reversals that bypass the per-session lock entirely (the contract's
  // CONCURRENCY rule on ReverseRound). These checks exercise exactly that
  // surface. Opt-in: they open derived sessions ("<sessionId>-conc-*") and
  // assume each has an independent balance, which holds for a mock or
  // sandboxed wallet.
  if (!opts.concurrency) {
    const reason = "concurrency not enabled (opt in with { concurrency: true })";
    skip("concurrency.parallel-distinct-settles", "concurrency", "parallel settles across distinct sessions conserve each session's balance", reason);
    skip("concurrency.duplicate-key-parallel", "concurrency", "the same idempotencyKey fired twice concurrently settles exactly once", reason);
    skip("concurrency.reverse-interleave", "concurrency", "concurrent reversals of two stacked rounds stay latest-first (no over-refund)", reason);
    skip("concurrency.post-storm-settle", "concurrency", "a plain sequential settle still reconciles after the concurrent storms", reason);
  } else {
    const cost = fixture.bet * fixture.priceMultiplier;
    const settle = (sessionId: string, idempotencyKey: string, win: number): Promise<RoundReceipt> =>
      adapter.settleSimple({
        sessionId,
        bet: fixture.bet,
        betIndex: fixture.betIndex,
        priceMultiplier: fixture.priceMultiplier,
        win,
        multiplier: win === 0 ? 0 : Math.round(win / fixture.bet),
        type: win === 0 ? "loss" : "win",
        roundState: "",
        idempotencyKey,
      });

    await run("concurrency.parallel-distinct-settles", "concurrency", "parallel settles across distinct sessions conserve each session's balance", async () => {
      // N sessions in parallel, M settles sequential WITHIN each session
      //  - the orchestrator serializes per session, so cross-session
      // parallelism is the only interleaving a conformant adapter must
      // survive. Per session: final == start - sum(costs) + sum(wins).
      const N = 8, M = 5;
      const problems: string[] = [];
      await Promise.all(Array.from({ length: N }, async (_, i) => {
        const sid = `${fixture.sessionId}-conc-p${i}`;
        const start = (await adapter.openSession(sid, `${fixture.connectionId}-conc-p${i}`)).balance;
        let wins = 0;
        let last: RoundReceipt | undefined;
        for (let j = 0; j < M; j++) {
          const win = j % 2 === 0 ? 0 : fixture.bet * 2;   // mix losses and wins
          last = await settle(sid, `conc-p${i}-${j}`, win);
          wins += win;
        }
        const expected = start - M * cost + wins;
        if (last!.balance !== expected) {
          problems.push(`${sid}: final balance ${last!.balance} != expected ${expected} (start ${start}, ${M} settles)`);
        }
      }));
      if (problems.length > 0) {
        throw new Error(`cross-session interference  - per-session conservation broken: ${problems.join("; ")}`);
      }
    });

    await run("concurrency.duplicate-key-parallel", "concurrency", "the same idempotencyKey fired twice concurrently settles exactly once", async () => {
      // The in-flight duplicate race: the sequential dedupe check above
      // sends the duplicate AFTER the original resolved; here both are in
      // flight at once (a retry racing its own original). Both must resolve
      // to the SAME receipt and money must move exactly once.
      const sid = `${fixture.sessionId}-conc-dup`;
      const start = (await adapter.openSession(sid, `${fixture.connectionId}-conc-dup`)).balance;
      const win = fixture.bet * 2;
      const req: SettleSimple = {
        sessionId: sid,
        bet: fixture.bet,
        betIndex: fixture.betIndex,
        priceMultiplier: fixture.priceMultiplier,
        win,
        multiplier: 2,
        type: "win",
        roundState: "",
        idempotencyKey: "conc-dup-parallel-1",   // SAME key, both calls
      };
      const [a, b] = await Promise.all([adapter.settleSimple(req), adapter.settleSimple({ ...req })]);
      if (a.roundId !== b.roundId) {
        throw new Error(`concurrent duplicates produced two rounds (${a.roundId} vs ${b.roundId})  - the dedupe has a read-then-write race`);
      }
      if (a.balance !== b.balance) {
        throw new Error(`concurrent duplicates disagree on balance (${a.balance} vs ${b.balance})`);
      }
      const after = (await adapter.openSession(sid, `${fixture.connectionId}-conc-dup-2`)).balance;
      const expected = start - cost + win;
      if (after !== expected) {
        throw new Error(`money moved more than once under the in-flight duplicate: balance ${after} != expected ${expected} (start ${start})`);
      }
    });

    if (typeof adapter.reverseRound !== "function") {
      skip("concurrency.reverse-interleave", "concurrency", "concurrent reversals of two stacked rounds stay latest-first (no over-refund)", "adapter does not implement reverseRound (optional)");
    } else {
      await run("concurrency.reverse-interleave", "concurrency", "concurrent reversals of two stacked rounds stay latest-first (no over-refund)", async () => {
        // Settle A then B, then fire reverseRound(A) and reverseRound(B)
        // concurrently. Reversal is wallet-initiated and bypasses the
        // per-session lock, so the adapter alone must order these. Two
        // serializations are legal:
        //   - A first: A is not latest -> no-op "not-latest-round"; B then
        //     reverses -> final balance is post-A.
        //   - B first: B reverses (A becomes latest); A then legally
        //     reverses too -> final balance is pre-A.
        // Anything else  - over-refund, double-credit, B refused  - fails.
        // Both rounds are net LOSSES on purpose: with only debits in play,
        // "final > pre-A balance" is a strict over-refund invariant (a
        // reversal credited more than the rounds ever took).
        const sid = `${fixture.sessionId}-conc-rev`;
        const bal0 = (await adapter.openSession(sid, `${fixture.connectionId}-conc-rev`)).balance;
        const rA = await settle(sid, "conc-rev-a", 0);
        const balA = rA.balance;
        const rB = await settle(sid, "conc-rev-b", 0);
        const [revA, revB] = await Promise.all([
          adapter.reverseRound!({ sessionId: sid, roundId: rA.roundId, reason: "conformance-interleave", idempotencyKey: "conc-rev-key-a" }),
          adapter.reverseRound!({ sessionId: sid, roundId: rB.roundId, reason: "conformance-interleave", idempotencyKey: "conc-rev-key-b" }),
        ]);
        const after = (await adapter.openSession(sid, `${fixture.connectionId}-conc-rev-2`)).balance;
        if (after > bal0) {
          throw new Error(`over-refund: balance ${after} > pre-round ${bal0}  - reversals credited more than the rounds moved`);
        }
        if (!revB.reversed) {
          throw new Error(`the latest round (B) must be reversible, got no-op "${revB.reason ?? "(no reason)"}"`);
        }
        if (revA.reversed) {
          // Legal only as the B-first serialization: both undone, balance
          // back to the pre-A snapshot.
          if (after !== bal0) {
            throw new Error(`both rounds reversed but balance ${after} != pre-A ${bal0}  - reversal restored the wrong snapshot`);
          }
        } else {
          if (revA.reason !== "not-latest-round") {
            throw new Error(`A was refused with "${revA.reason ?? "(no reason)"}"  - expected "not-latest-round" while B sat on top`);
          }
          if (after !== balA) {
            throw new Error(`only B reversed but balance ${after} != post-A ${balA}  - B's reversal restored the wrong snapshot`);
          }
        }
      });
    }

    await run("concurrency.post-storm-settle", "concurrency", "a plain sequential settle still reconciles after the concurrent storms", async () => {
      // Re-read a stormed session and run one boring settle  - the adapter's
      // bookkeeping must come out of the races consistent, not just lucky.
      const sid = `${fixture.sessionId}-conc-dup`;
      const before = (await adapter.openSession(sid, `${fixture.connectionId}-conc-after`)).balance;
      const win = fixture.bet;
      const r = await settle(sid, "conc-after-1", win);
      const expected = before - cost + win;
      if (r.balance !== expected) {
        throw new Error(`post-storm settle does not reconcile: balance ${r.balance} != expected ${expected} (before ${before})`);
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
