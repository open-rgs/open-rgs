// Orchestrator: the heart of the RGS. Resolves modes, computes bets,
// calls platform + math, threads carry, builds responses.
//
// Knows nothing about wire format (transports do that) or about specific
// platform protocols (the PlatformAdapter does that).

import {
  RGSError,
  type GameManifest,
  type PlatformAdapter,
  type OrchestratorAPI,
  type ConnectionMeta,
  type ClientRequestInit,
  type ClientRequestSpin,
  type ClientRequestOpenRound,
  type ClientRequestStepRound,
  type ClientRequestCloseRound,
  type ClientRequestPromoAccept,
  type ClientResponseInit,
  type ClientResponseSpin,
  type ClientResponseOpenRound,
  type ClientResponseStepRound,
  type ClientResponseCloseRound,
  type ClientResponsePromoAccept,
  type AutocloseRequest,
  type AutocloseResponse,
  type OpenRoundResume,
  type SimpleMath,
  type ComplexMath,
  type GameMode,
  type SpinContext,
  type CheatHint,
  type RoundOutcome,
  type CloseOutcome,
} from "@open-rgs/contract";
import * as sessions from "./session.js";
import * as promo from "./promo.js";
import { settleAmount } from "./money.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import { log } from "./log.js";
import type { RgsMetrics } from "./metrics-rgs.js";
import type { IdempotencyConfig } from "@open-rgs/contract";

export interface OrchestratorConfig {
  manifest: GameManifest;
  platform: PlatformAdapter;
  /** @deprecated No longer used by the orchestrator — cheats are gated by
   *  `cheatsEnabled`, not the environment. Accepted for back-compat. */
  isDev?: boolean;
  /** Enable the dev-only forced-outcome cheat path (read from
   *  `ClientRequestSpin.params.cheat`). Default false. createServer only
   *  sets this true outside production AND with an explicit opt-in
   *  (`enableCheats` / OPEN_RGS_ENABLE_CHEATS), so a forced-outcome path
   *  can never be reached in a production build. */
  cheatsEnabled?: boolean;
  /** Optional standard metrics registry. Created automatically by
   *  createServer; only passed explicitly in unit tests. */
  metrics?: RgsMetrics;
  /** Idempotency-key generator + retention. Defaults to uuid-v4 +
   *  5-minute TTL (a hint for upstream caches). */
  idempotency?: IdempotencyConfig;
}

/** Default idempotency-key generator: crypto.randomUUID (UUID v4). */
export function defaultIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Upper bound on a client-supplied priceMultiplier (feature-buy stake). A
 *  sane ceiling so a crafted value can't inflate the bet arbitrarily. */
const MAX_PRICE_MULTIPLIER = 100_000;

/** Wrap a platform RPC call with latency + error metrics. */
async function timedPlatformCall<T>(
  metrics: RgsMetrics | undefined,
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!metrics) return fn();
  const start = performance.now();
  try {
    const out = await fn();
    metrics.platformDuration.observe((performance.now() - start) / 1000, { method });
    return out;
  } catch (e) {
    metrics.platformDuration.observe((performance.now() - start) / 1000, { method });
    const reason = e instanceof Error ? errorReason(e.message) : "unknown";
    metrics.platformErrors.inc(1, { method, reason });
    throw e;
  }
}

function errorReason(msg: string): string {
  if (/InsufficientFunds/i.test(msg))         return "insufficient_funds";
  if (/SessionInvalid/i.test(msg))            return "session_invalid";
  if (/InvalidRoundOperation/i.test(msg))     return "invalid_round";
  if (/Timeout|timed out/i.test(msg))         return "timeout";
  if (/not connected|ENOTCONN|ECONN/i.test(msg)) return "disconnected";
  return "other";
}

export function createOrchestrator(cfg: OrchestratorConfig): OrchestratorAPI {
  const { manifest, platform, metrics } = cfg;
  const cheatsEnabled = cfg.cheatsEnabled ?? false;
  const genIdemKey = cfg.idempotency?.generate ?? defaultIdempotencyKey;

  // Idempotency key for a round-INITIATING call (simple spin / complex
  // open). No server-side round id exists yet, so retry-safety requires a
  // stable token from the client: when present we derive deterministically
  // from it; otherwise we fall back to a random key (a blind retry of a
  // round-initiating call WITHOUT a client token cannot be deduped — see
  // the contract's IdempotencyConfig and specs/05-platform-protocol.md).
  function initiatingIdemKey(sessionId: string, phase: "spin" | "open", clientToken?: string): string {
    return clientToken ? deriveIdempotencyKey(sessionId, phase, clientToken) : genIdemKey();
  }

  // ─── Per-session serialization ──────────────────────────────────────────
  //
  // JS is single-threaded, but every money op `await`s the math and the
  // wallet, and an `await` yields the event loop. So two operations on the
  // same session can interleave across their awaits:
  //   • a client CLOSE racing an autoclose (event/admin) — both read
  //     `s.openRound`, both call `closeComplex`;
  //   • two concurrent spins — both pass the `bet > balance` check against
  //     the same stale balance, then both settle → overspend.
  // We chain each session's operations into a queue so at most one runs at
  // a time. Once an op holds the lock it runs start-to-finish (including
  // clearing `s.openRound`) before the next begins, so the "read then clear
  // after the await" pattern becomes safe and a second close finds no open
  // round. Autoclose from platform events goes through the same lock.
  const sessionChains = new Map<string, Promise<unknown>>();

  function runLocked<T>(sid: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    // No session id yet (e.g. a request missing sid) — nothing to serialize
    // against; run directly and let the impl throw the proper error.
    if (!sid) return fn();
    const prev = sessionChains.get(sid) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run after prev settles, success or fail
    const tail = run.then(() => {}, () => {}); // swallow so the chain never wedges
    sessionChains.set(sid, tail);
    // Drop the entry once the queue drains, so the map doesn't grow forever.
    void tail.then(() => {
      if (sessionChains.get(sid) === tail) sessionChains.delete(sid);
    });
    return run;
  }

  // Wire platform events into local session cache.
  platform.onEvent((e) => {
    if (e.type === "balanceChanged") {
      sessions.setBalance(e.sessionId, e.balance);
    } else if (e.type === "sessionClosed") {
      // If the session has an in-flight round, autoclose it first so
      // money settles cleanly before we drop the local cache.
      const s = sessions.get(e.sessionId);
      if (s?.openRound) {
        autocloseRound({
          sessionId: e.sessionId,
          roundId: s.openRound.roundId,
          reason: `session-closed: ${e.reason}`,
        }).catch((err) => log.exception("autoclose-on-session-close failed", err, {
          "event.category": "orchestrator",
          "session.id": e.sessionId,
        })).finally(() => { sessions.remove(e.sessionId); metrics?.sessionsActive.dec(); });
      } else {
        sessions.remove(e.sessionId);
        metrics?.sessionsActive.dec();
      }
    } else if (e.type === "promoGranted") {
      const s = sessions.get(e.sessionId);
      if (s) s.promo = sessions.promoFromApi(e.promo);
    } else if (e.type === "autocloseRequested") {
      // External signal — find the round, run math.autoclose, settle.
      autocloseRound({
        sessionId: e.sessionId,
        ...(e.roundId !== undefined ? { roundId: e.roundId } : {}),
        reason: e.reason,
      }).catch((err) => log.exception("autocloseRequested handler failed", err, {
        "event.category": "orchestrator",
        "session.id": e.sessionId,
      }));
    } else {
      // An adapter emitting an unrecognised event type (e.g. the legacy
      // "campaignGranted" instead of "promoGranted") would otherwise have
      // its event silently dropped — and free-round grants would vanish.
      // Make the mismatch visible.
      log.warn("Dropped unknown platform event type", {
        "event.category": "orchestrator",
        "event.action": "unknown_platform_event",
        "platform.event_type": (e as { type?: string }).type ?? "(none)",
      });
    }
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function modeOrThrow(modeId: string): GameMode {
    const m = manifest.modes[modeId];
    if (!m) throw new RGSError("INVALID_MODE", `Unknown mode '${modeId}'`);
    return m;
  }

  function resolveRequestedMode(s: sessions.LocalSession, requested?: string): string {
    // Active promo pool with no mode-filter overrides everything: client
    // is on bonus, force the default mode. If the pool has a mode filter,
    // honour it instead (let resolution fall through to the filter check).
    const promoActive = promo.activeOverride(s);
    if (promoActive && !s.promo?.modeFilter) return manifest.defaultMode;
    // nextMode from prior round's math output overrides client request.
    if (s.nextMode) return s.nextMode;
    return requested ?? manifest.defaultMode;
  }

  function buildSpinContext(modeId: string, cheatRaw?: Record<string, unknown>, params?: Record<string, unknown>): SpinContext {
    // Cheats are fully off unless explicitly enabled outside production
    // (see OrchestratorConfig.cheatsEnabled) — a forced-outcome path can
    // never be reached in a production build.
    const cheat = cheatsEnabled ? parseCheat(cheatRaw) : undefined;
    return { mode: modeId, cheat, params };
  }

  function computeBet(
    s: sessions.LocalSession,
    mode: GameMode,
    modeId: string,
    requestedBetIndex: number | undefined,
    requestedPriceMultiplier: number | undefined,
  ): { bet: number; betIndex: number; priceMultiplier: number; promoId?: string } {
    const promoOv = promo.activeOverride(s, modeId);
    if (promoOv) {
      const idx = s.allowedBets.indexOf(promoOv.bet);
      if (idx < 0) throw new RGSError("INVALID_BET", "Promo-locked bet not in allowedBets");
      return { bet: promoOv.bet, betIndex: idx, priceMultiplier: 1, promoId: promoOv.promoId };
    }
    const betIndex = requestedBetIndex ?? s.defaultBetIndex;
    if (!Number.isInteger(betIndex) || betIndex < 0 || betIndex >= s.allowedBets.length) {
      throw new RGSError("INVALID_BET", `betIndex ${betIndex} out of range`);
    }
    const baseBet = s.allowedBets[betIndex]!;
    // priceMultiplier is client-supplied — validate it like betIndex. A
    // crafted large/fractional value would otherwise inflate the bet or make
    // it non-integer (feeding the money path bad input). (M4)
    const priceMultiplier = requestedPriceMultiplier ?? 1;
    if (!Number.isInteger(priceMultiplier) || priceMultiplier < 1 || priceMultiplier > MAX_PRICE_MULTIPLIER) {
      throw new RGSError("INVALID_BET", `priceMultiplier must be an integer in [1, ${MAX_PRICE_MULTIPLIER}], got ${priceMultiplier}`);
    }
    const bet = baseBet * priceMultiplier * mode.stakeMultiplier;
    // Every amount that crosses to the wallet is an integer minor unit; a
    // fractional stakeMultiplier (or bad base) must not produce a fractional
    // bet. (0 is allowed — free-round modes.)
    if (!Number.isInteger(bet) || bet < 0) {
      throw new RGSError("INVALID_BET", `computed bet must be a non-negative integer minor unit, got ${bet}`);
    }
    return { bet, betIndex, priceMultiplier };
  }

  function modeCatalogForClient() {
    const out: { id: string; label?: string; stakeMultiplier: number; declaredRtp?: number }[] = [];
    for (const [id, m] of Object.entries(manifest.modes)) {
      if (m.internal) continue;
      out.push({ id, label: m.label, stakeMultiplier: m.stakeMultiplier, declaredRtp: m.declaredRtp ?? m.math.rtp });
    }
    return out;
  }

  // ─── INIT ───────────────────────────────────────────────────────────────

  async function init(req: ClientRequestInit, conn: ConnectionMeta): Promise<ClientResponseInit> {
    if (!req.sid) throw new RGSError("MISSING_SESSION", "sid required");
    if (!platform.isHealthy) throw new RGSError("GAMES_API_UNAVAILABLE", "Platform not connected");

    // Resume path: if a session for this sid is already in our cache (e.g.
    // the player disconnected mid-round and reconnected), reuse it. The
    // openRound's full opsLog + actionLog + awaiting tell the new
    // connection exactly what happened and what's next.
    let s = sessions.get(req.sid);
    let info: import("@open-rgs/contract").SessionInfo;

    if (s?.openRound) {
      // Don't re-call openSession on the platform — we still own this
      // session locally and the platform still has the round open. Refresh
      // balance from the platform's last known value (BalanceChangedEvent
      // keeps it current). Connection metadata gets updated.
      conn.sessionId = s.sessionId;
      conn.demo = !s.currency;
      info = {
        sessionId: s.sessionId,
        currency: s.currency,
        currencyDecimals: s.currencyDecimals,
        balance: s.balance,
        allowedBets: s.allowedBets,
        defaultBetIndex: s.defaultBetIndex,
        ...(s.promo ? { promo: {
          id: s.promo.id,
          bet: s.promo.bet,
          remaining: s.promo.remaining,
          ...(s.promo.modeFilter ? { modeFilter: s.promo.modeFilter } : {}),
          ...(s.promo.label !== undefined ? { label: s.promo.label } : {}),
          ...(s.promo.total !== undefined ? { total: s.promo.total } : {}),
          ...(s.promo.validTo !== undefined ? { validTo: s.promo.validTo } : {}),
        } } : {}),
      };
      log.info("Resuming session with open round", {
        "event.category": "orchestrator",
        "event.action": "init_resume",
        "session.id": req.sid,
        "round.id": s.openRound.roundId,
        "round.mode": s.openRound.modeId,
        "round.actions_so_far": s.openRound.actionLog.length,
      });
    } else {
      // Fresh INIT — go to platform, build a new LocalSession from
      // the SessionInfo it returns (per ADR-004, platform is the
      // source of truth for carry / nextMode / mathVersion).
      info = await timedPlatformCall(metrics, "openSession",
        () => platform.openSession(req.sid, conn.connectionId));
      conn.sessionId = req.sid;
      conn.demo = !info.currency;
      metrics?.sessionsActive.inc();

      // Math-version migration: if the platform returns a carry but
      // its mathVersion doesn't match what's currently loaded, we
      // discard the carry. Manifest.recovery policy could in future
      // allow different strategies; for v0.1 we always discard-and-fresh.
      let restoredCarry: string | undefined = info.carry;
      let restoredNextMode: string | undefined = info.nextMode;
      if (info.mathVersion && restoredCarry !== undefined) {
        const targetMode = info.nextMode ?? manifest.defaultMode;
        const currentMode = manifest.modes[targetMode];
        const currentVersion = currentMode?.math.version;
        if (currentVersion && currentVersion !== info.mathVersion) {
          log.warn("Carry math-version mismatch — discarding", {
            "event.category": "orchestrator",
            "event.action": "carry_version_mismatch",
            "session.id": req.sid,
            "math.version.stored": info.mathVersion,
            "math.version.current": currentVersion,
            "mode.id": targetMode,
          });
          restoredCarry = undefined;
          restoredNextMode = undefined;
        }
      }

      s = {
        sessionId: req.sid,
        connectionId: conn.connectionId,
        balance: info.balance,
        currency: info.currency,
        currencyDecimals: info.currencyDecimals,
        allowedBets: info.allowedBets,
        defaultBetIndex: info.defaultBetIndex,
        ...(restoredCarry !== undefined ? { carry: restoredCarry } : {}),
        ...(restoredNextMode !== undefined ? { nextMode: restoredNextMode } : {}),
        ...(info.promo && info.promo.remaining > 0 ? { promo: sessions.promoFromApi(info.promo) } : {}),
        createdAt: Date.now(),
      };
      sessions.put(s);

      if (restoredCarry !== undefined) {
        log.info("Carry restored from platform", {
          "event.category": "orchestrator",
          "event.action": "carry_restored",
          "session.id": req.sid,
          "carry.bytes": restoredCarry.length,
          ...(restoredNextMode !== undefined ? { "next_mode": restoredNextMode } : {}),
        });
      }
    }

    const resp: ClientResponseInit = {
      sid: req.sid,
      balance: info.balance,
      currency: info.currency,
      currencyDecimals: info.currencyDecimals,
      allowedBets: info.allowedBets,
      defaultBetIndex: info.defaultBetIndex,
      modes: modeCatalogForClient(),
      ...(conn.demo ? { demo: true as const } : {}),
    };

    if (s.promo) {
      resp.promo = {
        id: s.promo.id,
        bet: s.promo.bet,
        remaining: s.promo.remaining,
        ...(s.promo.total !== undefined ? { total: s.promo.total } : {}),
        ...(s.promo.label !== undefined ? { label: s.promo.label } : {}),
        ...(s.promo.validTo !== undefined ? { validTo: s.promo.validTo } : {}),
      };
      promo.markOffered(s);
    }

    // Resume payload — same-process reconnect, full replay context.
    if (s.openRound) {
      const r: OpenRoundResume = {
        roundId: s.openRound.roundId,
        modeId: s.openRound.modeId,
        bet: s.openRound.bet,
        ops: s.openRound.opsLog,
        actionLog: s.openRound.actionLog,
        ...(s.openRound.awaiting ? { awaiting: s.openRound.awaiting } : {}),
        openedAt: s.openRound.openedAt,
      };
      resp.resume = r;
    }

    log.info("Session initialized", {
      "event.category": "orchestrator",
      "event.action": "init_ok",
      "session.id": req.sid,
      "session.balance": info.balance,
      "session.currency": info.currency,
      "session.demo": conn.demo,
      "session.has_promo": Boolean(s.promo),
      "session.has_resume": Boolean(s.openRound),
    });
    return resp;
  }

  // ─── SIMPLE SPIN ────────────────────────────────────────────────────────

  async function spin(req: ClientRequestSpin, conn: ConnectionMeta): Promise<ClientResponseSpin> {
    const roundStart = performance.now();
    const s = sessionOrThrow(req.sid ?? conn.sessionId);
    // A simple spin must not mutate a session that has a complex round
    // in flight (its debited stake is still outstanding). (M5)
    if (s.openRound) {
      throw new RGSError("ROUND_ALREADY_OPEN", "Finish the open complex round before a simple spin");
    }
    const requestedMode = resolveRequestedMode(s, req.mode);
    const mode = modeOrThrow(requestedMode);

    if (mode.math.kind !== "simple") {
      throw new RGSError("INVALID_MODE", `Mode '${requestedMode}' is complex; use openRound instead`);
    }

    const betInfo = computeBet(s, mode, requestedMode, req.betIndex, req.priceMultiplier);

    if (!betInfo.promoId && betInfo.bet > s.balance) {
      throw new RGSError("INSUFFICIENT_BALANCE", `bet ${betInfo.bet} > balance ${s.balance}`);
    }

    // Dev cheats (when enabled) ride inside params.cheat — never a
    // first-class wire field. Ignored entirely when cheatsEnabled is false.
    const ctx = buildSpinContext(requestedMode, req.params?.["cheat"] as Record<string, unknown> | undefined, req.params);
    const math = mode.math as SimpleMath;
    const mathStart = performance.now();
    const outcome = await Promise.resolve(math.play(s.carry, ctx));
    metrics?.mathDuration.observe((performance.now() - mathStart) / 1000, { kind: "simple", mode: requestedMode, phase: "play" });

    // Apply max-win cap (per-mode override → game-wide default → none).
    // The cap is a regulatory requirement in most jurisdictions; we
    // clip win + multiplier and stamp type="max_win_reached" so the
    // client can render a CONGRATULATIONS-YOU-MAXED-OUT screen.
    const cappedOutcome = applyMaxWinCap(
      outcome,
      betInfo.bet,
      mode.maxWinMultiplier ?? manifest.maxWinMultiplier,
    );
    // Money is integer minor units; the multiplier is a float, so round
    // the product half-to-even at this one boundary (ADR-002).
    const win = settleAmount(cappedOutcome.multiplier, betInfo.bet);

    let receipt;
    try {
      // Default round_state envelope when the math returns no carry.
      // Some platforms (your platform, ...) validate this as required-non-empty,
      // so we ALWAYS send a meaningful audit envelope describing the
      // round outcome — never an empty string. When the math DOES set
      // carry, we forward it verbatim; the math owns the format.
      const roundState = cappedOutcome.carry ?? JSON.stringify({
        type:       cappedOutcome.type,
        multiplier: cappedOutcome.multiplier,
        win,
        bet:        betInfo.bet,
        bet_index:  betInfo.betIndex,
      });

      receipt = await timedPlatformCall(metrics, "settleSimple", () => platform.settleSimple({
        sessionId: s.sessionId,
        bet: betInfo.bet,
        betIndex: betInfo.betIndex,
        priceMultiplier: betInfo.priceMultiplier * mode.stakeMultiplier,
        win,
        multiplier: cappedOutcome.multiplier,
        type: cappedOutcome.type,
        roundState,
        ...(cappedOutcome.nextMode !== undefined ? { nextMode: cappedOutcome.nextMode } : {}),
        ...(mode.math.version ? { mathVersion: mode.math.version } : {}),
        idempotencyKey: initiatingIdemKey(s.sessionId, "spin", req.idempotencyKey),
        ...(betInfo.promoId ? { promoId: betInfo.promoId } : {}),
      }));
    } catch (e) {
      throw translate(e, "SPIN_FAILED");
    }

    metrics?.roundTotal.inc(1, { kind: "simple", mode: requestedMode, type: cappedOutcome.type });
    metrics?.roundDuration.observe((performance.now() - roundStart) / 1000, { kind: "simple", mode: requestedMode });

    sessions.setBalance(s.sessionId, receipt.balance);
    sessions.setCarry(s.sessionId, cappedOutcome.carry, cappedOutcome.nextMode);

    // Capture promo state for the response BEFORE applyUpdate may drain
    // the pool (we want to surface the post-round view to the client).
    const wasPromo = Boolean(betInfo.promoId);
    if (receipt.promo) promo.applyUpdate(s, receipt.promo);

    // Math returned ops; we forward them as-is. Balance is a separate
    // top-level response field — math is currency-blind.
    const resp: ClientResponseSpin = {
      roundId: receipt.roundId,
      ops: cappedOutcome.ops,
      balance: receipt.balance,
      bet: betInfo.bet,
      win,
      multiplier: cappedOutcome.multiplier,
      type: cappedOutcome.type,
    };

    if (wasPromo) {
      resp.promo = {
        remaining: s.promo?.remaining ?? 0,
        done: !s.promo || s.promo.remaining <= 0,
      };
    }

    return resp;
  }

  // ─── COMPLEX OPEN ───────────────────────────────────────────────────────

  async function openRound(req: ClientRequestOpenRound, conn: ConnectionMeta): Promise<ClientResponseOpenRound> {
    const s = sessionOrThrow(req.sid ?? conn.sessionId);
    if (s.openRound) throw new RGSError("ROUND_ALREADY_OPEN", "Close current round first");

    const requestedMode = resolveRequestedMode(s, req.mode);
    const mode = modeOrThrow(requestedMode);
    if (mode.math.kind !== "complex") {
      throw new RGSError("INVALID_MODE", `Mode '${requestedMode}' is simple; use spin instead`);
    }

    const betInfo = computeBet(s, mode, requestedMode, req.betIndex, req.priceMultiplier);
    if (!betInfo.promoId && betInfo.bet > s.balance) {
      throw new RGSError("INSUFFICIENT_BALANCE", `bet ${betInfo.bet} > balance ${s.balance}`);
    }

    const ctx = buildSpinContext(requestedMode, undefined, req.params);
    const math = mode.math as ComplexMath;
    const mathStart = performance.now();
    const open = await Promise.resolve(math.open(s.carry, ctx));
    metrics?.mathDuration.observe((performance.now() - mathStart) / 1000, { kind: "complex", mode: requestedMode, phase: "open" });

    let receipt;
    try {
      receipt = await timedPlatformCall(metrics, "openComplex", () => platform.openComplex({
        sessionId: s.sessionId,
        bet: betInfo.bet,
        betIndex: betInfo.betIndex,
        priceMultiplier: betInfo.priceMultiplier * mode.stakeMultiplier,
        initialState: open.state,
        idempotencyKey: initiatingIdemKey(s.sessionId, "open", req.idempotencyKey),
        ...(betInfo.promoId ? { promoId: betInfo.promoId } : {}),
      }));
    } catch (e) {
      throw translate(e, "OPEN_FAILED");
    }

    sessions.setBalance(s.sessionId, receipt.balance);
    s.openRound = {
      roundId: receipt.roundId,
      modeId: requestedMode,
      bet: betInfo.bet,
      state: open.state,
      ...(open.awaiting ? { awaiting: open.awaiting } : {}),
      actionLog: [],
      opsLog: [...open.ops],
      openedAt: Date.now(),
    };

    return {
      roundId: receipt.roundId,
      ops: open.ops,
      balance: receipt.balance,
      bet: betInfo.bet,
      awaiting: open.awaiting,
    };
  }

  // ─── COMPLEX STEP ───────────────────────────────────────────────────────

  async function stepRound(req: ClientRequestStepRound, conn: ConnectionMeta): Promise<ClientResponseStepRound> {
    const s = sessionOrThrow(req.sid ?? conn.sessionId);
    const open = s.openRound;
    if (!open) throw new RGSError("NO_ROUND_OPEN", "No round in progress");

    if (open.awaiting && open.awaiting.type !== req.action.type) {
      throw new RGSError("INVALID_ACTION", `expected ${open.awaiting.type}, got ${req.action.type}`);
    }

    const mode = modeOrThrow(open.modeId);
    const math = mode.math as ComplexMath;

    let stepResult;
    try {
      const mathStart = performance.now();
      stepResult = await Promise.resolve(math.step(open.state, req.action));
      metrics?.mathDuration.observe((performance.now() - mathStart) / 1000, { kind: "complex", mode: open.modeId, phase: "step" });
    } catch (e) {
      throw translate(e, "STEP_FAILED");
    }

    open.state = stepResult.state;
    if (stepResult.awaiting) open.awaiting = stepResult.awaiting;
    else delete open.awaiting;
    open.actionLog.push(req.action);
    open.opsLog.push(...stepResult.ops);

    // Optional audit checkpoint, fire-and-forget if provider supports it.
    if (typeof platform.updateComplex === "function") {
      void timedPlatformCall(metrics, "updateComplex", () => platform.updateComplex!({
        sessionId: s.sessionId,
        roundId: open.roundId,
        state: open.state,
      })).catch((err) => log.warn("audit updateComplex failed", { "error.message": String(err) }));
    }

    return {
      ops: stepResult.ops,
      ...(stepResult.awaiting ? { awaiting: stepResult.awaiting } : {}),
    };
  }

  // ─── COMPLEX CLOSE ──────────────────────────────────────────────────────

  async function closeRound(req: ClientRequestCloseRound, conn: ConnectionMeta): Promise<ClientResponseCloseRound> {
    const s = sessionOrThrow(req.sid ?? conn.sessionId);
    const open = s.openRound;
    if (!open) throw new RGSError("NO_ROUND_OPEN", "No round in progress");

    const mode = modeOrThrow(open.modeId);
    const math = mode.math as ComplexMath;

    if (!(await Promise.resolve(math.isTerminal(open.state)))) {
      throw new RGSError("INVALID_ROUND", "Round not terminal yet — finish the flow first");
    }

    const roundStart = open.openedAt;
    let closeResult;
    try {
      const mathStart = performance.now();
      closeResult = await Promise.resolve(math.close(open.state));
      metrics?.mathDuration.observe((performance.now() - mathStart) / 1000, { kind: "complex", mode: open.modeId, phase: "close" });
    } catch (e) {
      throw translate(e, "CLOSE_FAILED");
    }

    const cappedClose = applyMaxWinCapClose(
      closeResult,
      open.bet,
      mode.maxWinMultiplier ?? manifest.maxWinMultiplier,
    );
    const win = settleAmount(cappedClose.multiplier, open.bet);
    let receipt;
    try {
      receipt = await timedPlatformCall(metrics, "closeComplex", () => platform.closeComplex({
        sessionId: s.sessionId,
        roundId: open.roundId,
        finalState: open.state,
        win,
        multiplier: cappedClose.multiplier,
        type: cappedClose.type,
        ...(cappedClose.carry !== undefined ? { carry: cappedClose.carry } : {}),
        ...(cappedClose.nextMode !== undefined ? { nextMode: cappedClose.nextMode } : {}),
        ...(mode.math.version ? { mathVersion: mode.math.version } : {}),
        // Deterministic per-round close key: client CLOSE and an external
        // autoclose of the same round derive the identical key, so the
        // wallet dedupes any duplicate/raced close into one credit.
        idempotencyKey: deriveIdempotencyKey(s.sessionId, open.roundId, "close"),
      }));
    } catch (e) {
      throw translate(e, "CLOSE_FAILED");
    }

    metrics?.roundTotal.inc(1, { kind: "complex", mode: open.modeId, type: cappedClose.type });
    metrics?.roundDuration.observe((Date.now() - roundStart) / 1000, { kind: "complex", mode: open.modeId });

    sessions.setBalance(s.sessionId, receipt.balance);
    sessions.setCarry(s.sessionId, cappedClose.carry, cappedClose.nextMode);
    if (receipt.promo) promo.applyUpdate(s, receipt.promo);
    s.openRound = undefined;

    return {
      roundId: receipt.roundId,
      ops: cappedClose.ops,
      balance: receipt.balance,
      win,
      multiplier: cappedClose.multiplier,
      type: cappedClose.type,
    };
  }

  // ─── Promo accept/decline ──────────────────────────────────────────────

  async function promoAccept(req: ClientRequestPromoAccept, conn: ConnectionMeta): Promise<ClientResponsePromoAccept> {
    const s = sessionOrThrow(req.sid ?? conn.sessionId);
    if (!s.promo || s.promo.remaining <= 0) return { ok: false };

    if (!req.accept) {
      promo.decline(s);
      return { ok: true };
    }
    const ok = promo.activate(s);
    if (!ok) return { ok: false };
    return {
      ok: true,
      promo: {
        id: s.promo.id,
        bet: s.promo.bet,
        remaining: s.promo.remaining,
        ...(s.promo.total !== undefined ? { total: s.promo.total } : {}),
      },
    };
  }

  // ─── External AUTOCLOSE ─────────────────────────────────────────────────
  // Triggered by:
  //   • PlatformEvent { type: "autocloseRequested" } from upstream platform
  //   • PlatformEvent { type: "sessionClosed" } when an open round exists
  //   • Admin HTTP POST /api/autoclose for operator scripts
  // NEVER by an in-process timer.

  // Locked wrapper — used by both the public API and the platform-event
  // handler above, so an autoclose serializes against a client close of the
  // same session.
  function autocloseRound(req: AutocloseRequest): Promise<AutocloseResponse> {
    return runLocked(req.sessionId, () => autocloseRoundImpl(req));
  }

  async function autocloseRoundImpl(req: AutocloseRequest): Promise<AutocloseResponse> {
    const s = sessions.get(req.sessionId);
    if (!s) return { closed: false, reason: "session-not-found" };

    const open = s.openRound;
    if (!open) return { closed: false, reason: "no-round-open" };

    if (req.roundId && req.roundId !== open.roundId) {
      return { closed: false, reason: "round-id-mismatch" };
    }

    const mode = manifest.modes[open.modeId];
    if (!mode || mode.math.kind !== "complex") {
      return { closed: false, reason: "mode-not-complex" };
    }
    const math = mode.math as ComplexMath;

    // Honour the game-declared AutoclosePolicy (was previously ignored, and
    // a round with banked value could be silently forfeited).
    const policy = manifest.autoclose?.policy ?? "math-decides";
    if (policy === "hold") {
      // Don't autoclose — the round persists for later resolution.
      return { closed: false, reason: "policy-hold" };
    }

    let closeResult;
    try {
      if (policy === "settle-as-loss") {
        // Operator explicitly chose to forfeit on abandonment.
        closeResult = { multiplier: 0, ops: [], type: "autoclose-loss" };
      } else if (typeof math.autoclose === "function") {
        // math-decides / settle-at-current both prefer the math's valuation.
        closeResult = await Promise.resolve(math.autoclose(open.state));
      } else if (await Promise.resolve(math.isTerminal(open.state))) {
        closeResult = await Promise.resolve(math.close(open.state));
      } else if (policy === "settle-at-current") {
        // settle-at-current needs a valuation the math didn't provide.
        // Refuse rather than silently forfeit banked player value — surface
        // the misconfiguration; the round stays open for resolution.
        log.error("Autoclose policy 'settle-at-current' but math has no autoclose() valuation — refusing to forfeit", {
          "event.category": "autoclose",
          "session.id": req.sessionId,
          "round.id": open.roundId,
          "mode.id": open.modeId,
        });
        return { closed: false, reason: "settle-at-current-requires-math-autoclose" };
      } else {
        // math-decides, no autoclose, not terminal — conservative loss (no
        // surprise pay-out from a stale state). Games that can leave value on
        // the table should implement math.autoclose or use settle-at-current.
        closeResult = { multiplier: 0, ops: [], type: "autoclose-loss" };
      }
    } catch (e) {
      log.exception("Autoclose math call failed", e, {
        "event.category": "autoclose",
        "session.id": req.sessionId,
        "round.id": open.roundId,
      });
      return { closed: false, reason: `math-error: ${e instanceof Error ? e.message : String(e)}` };
    }

    // Autoclose moves money too, so it must run the same sanitize + cap
    // path as a client close — otherwise a non-finite/negative multiplier
    // from math.autoclose() (or a cap-exceeding one) would settle unguarded.
    const cappedClose = applyMaxWinCapClose(
      closeResult,
      open.bet,
      mode.maxWinMultiplier ?? manifest.maxWinMultiplier,
    );
    const win = settleAmount(cappedClose.multiplier, open.bet);
    let receipt;
    try {
      receipt = await timedPlatformCall(metrics, "closeComplex", () => platform.closeComplex({
        sessionId: s.sessionId,
        roundId: open.roundId,
        finalState: open.state,
        win,
        multiplier: cappedClose.multiplier,
        type: cappedClose.type,
        // Same deterministic key as a client close of this round (above) —
        // a close racing an autoclose collapses to one wallet credit.
        idempotencyKey: deriveIdempotencyKey(s.sessionId, open.roundId, "close"),
        // Forward the autoclose trigger reason for the wallet's audit trail
        // (a normal client close omits it).
        reason: req.reason,
      }));
    } catch (e) {
      log.exception("Autoclose platform.closeComplex failed", e, {
        "event.category": "autoclose",
        "session.id": req.sessionId,
        "round.id": open.roundId,
      });
      return { closed: false, reason: `platform-error: ${e instanceof Error ? e.message : String(e)}` };
    }

    metrics?.roundTotal.inc(1, { kind: "complex", mode: open.modeId, type: cappedClose.type });
    metrics?.roundDuration.observe((Date.now() - open.openedAt) / 1000, { kind: "complex", mode: open.modeId });

    sessions.setBalance(s.sessionId, receipt.balance);
    sessions.setCarry(
      s.sessionId,
      cappedClose.carry,
      cappedClose.nextMode,
    );
    if (receipt.promo) promo.applyUpdate(s, receipt.promo);
    s.openRound = undefined;

    log.info("Round autoclosed", {
      "event.category": "autoclose",
      "event.action": "autoclose_ok",
      "session.id": s.sessionId,
      "round.id": receipt.roundId,
      "autoclose.reason": req.reason,
      "round.win": win,
      "round.multiplier": cappedClose.multiplier,
    });

    return { closed: true, roundId: receipt.roundId };
  }

  function onDisconnect(conn: ConnectionMeta): void {
    if (!conn.sessionId) return;
    const s = sessions.get(conn.sessionId);
    if (!s) return;

    // Keep the session in cache if a round is open — the player may
    // reconnect within the platform's grace window and resume. Autoclose
    // will be triggered externally (platform event or admin API call) if
    // the platform decides the player isn't coming back.
    if (s.openRound) {
      log.info("Connection dropped with open round — session retained for resume", {
        "event.category": "orchestrator",
        "event.action": "disconnect_with_open_round",
        "session.id": conn.sessionId,
        "round.id": s.openRound.roundId,
        "round.actions_so_far": s.openRound.actionLog.length,
      });
      return;
    }

    sessions.remove(conn.sessionId);
    metrics?.sessionsActive.dec();
  }

  // Serialize every client-facing operation per session (autocloseRound is
  // already wrapped above). The lock key is the session id the request
  // targets; a request with no resolvable session id runs unlocked and
  // throws the appropriate "missing session" error inside the impl.
  return {
    init: (req, conn) => runLocked(req.sid, () => init(req, conn)),
    spin: (req, conn) => runLocked(req.sid ?? conn.sessionId, () => spin(req, conn)),
    openRound: (req, conn) => runLocked(req.sid ?? conn.sessionId, () => openRound(req, conn)),
    stepRound: (req, conn) => runLocked(req.sid ?? conn.sessionId, () => stepRound(req, conn)),
    closeRound: (req, conn) => runLocked(req.sid ?? conn.sessionId, () => closeRound(req, conn)),
    promoAccept: (req, conn) => runLocked(req.sid ?? conn.sessionId, () => promoAccept(req, conn)),
    autocloseRound,
    onDisconnect,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sessionOrThrow(id: string | null | undefined): sessions.LocalSession {
  if (!id) throw new RGSError("MISSING_SESSION", "sid required — INIT first");
  const s = sessions.get(id);
  if (!s) throw new RGSError("SESSION_NOT_FOUND", "Session not initialized — INIT first");
  return s;
}

function parseCheat(raw: Record<string, unknown> | undefined): CheatHint | undefined {
  if (!raw) return undefined;
  const c: CheatHint = {};
  if (raw["force_win"]     !== undefined) c.force_win     = Boolean(raw["force_win"]);
  if (raw["force_coeff"]   !== undefined) c.force_coeff   = Number(raw["force_coeff"]);
  if (raw["force_feature"] !== undefined) c.force_feature = String(raw["force_feature"]);
  if (raw["force_big_win"] !== undefined) c.force_big_win = Boolean(raw["force_big_win"]);
  if (raw["force_noop"]    !== undefined) c.force_noop    = Boolean(raw["force_noop"]);
  return Object.keys(c).length ? c : undefined;
}

function translate(e: unknown, fallback: import("@open-rgs/contract").RGSErrorCode): RGSError {
  if (e instanceof RGSError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // Map common upstream errors.
  if (/InsufficientFunds/i.test(msg)) return new RGSError("INSUFFICIENT_BALANCE", msg);
  if (/SessionInvalid/i.test(msg))    return new RGSError("SESSION_INVALID", msg);
  if (/InvalidRoundOperation/i.test(msg)) return new RGSError("INVALID_ROUND", msg);
  return new RGSError(fallback, msg);
}

/** Validate a math-produced multiplier *before* it ever touches money.
 *
 *  This is the single guard between untrusted math output and a settle
 *  call, so it must fail closed. The old cap check (`multiplier <= cap`)
 *  was the only validation and it was backwards for bad inputs: `NaN <= cap`
 *  and `Infinity <= cap` are both `false`, so a non-finite multiplier fell
 *  through to the cap branch and paid out `cap × bet` — a math bug became a
 *  *maximum* payout. A negative multiplier passed the check unchanged and
 *  produced a negative settlement.
 *
 *  Rules:
 *   - non-finite (NaN / ±Infinity) → hard error; fail the round, never pay.
 *   - negative → clamp to 0 (treat as a loss); money never flows backwards.
 *   - finite, ≥ 0 → returned unchanged for the caller to cap. */
function sanitizeMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) {
    throw new RGSError("INTERNAL_ERROR", "math returned a non-finite multiplier");
  }
  return multiplier < 0 ? 0 : multiplier;
}

/** Apply max-win cap to a simple-round outcome. The multiplier is first
 *  sanitized (see sanitizeMultiplier — non-finite throws, negative clamps
 *  to 0). If the cap then fires:
 *  - multiplier is clipped to maxMultiplier
 *  - type is stamped as "max_win_reached" so the client can render
 *    the max-win celebration
 *  - ops are preserved; if the cap fired, we append a "max_win" op
 *    so the client knows visually
 *  When no cap or outcome is under cap → returned with the sanitized
 *  multiplier (unchanged when it was already finite and non-negative). */
export function applyMaxWinCap(
  outcome: RoundOutcome,
  _bet: number,
  maxMultiplier: number | undefined,
): RoundOutcome {
  const multiplier = sanitizeMultiplier(outcome.multiplier);
  if (maxMultiplier == null || multiplier <= maxMultiplier) {
    return multiplier === outcome.multiplier ? outcome : { ...outcome, multiplier };
  }
  return {
    multiplier: maxMultiplier,
    ops: [...outcome.ops, { kind: "max_win", cap_multiplier: maxMultiplier, raw_multiplier: multiplier }],
    type: "max_win_reached",
    ...(outcome.carry !== undefined ? { carry: outcome.carry } : {}),
    ...(outcome.nextMode !== undefined ? { nextMode: outcome.nextMode } : {}),
  };
}

/** Same sanitize-then-cap applied to a complex-round close outcome. */
export function applyMaxWinCapClose(
  outcome: CloseOutcome,
  _bet: number,
  maxMultiplier: number | undefined,
): CloseOutcome {
  const multiplier = sanitizeMultiplier(outcome.multiplier);
  if (maxMultiplier == null || multiplier <= maxMultiplier) {
    return multiplier === outcome.multiplier ? outcome : { ...outcome, multiplier };
  }
  return {
    multiplier: maxMultiplier,
    ops: [...outcome.ops, { kind: "max_win", cap_multiplier: maxMultiplier, raw_multiplier: multiplier }],
    type: "max_win_reached",
    ...(outcome.carry !== undefined ? { carry: outcome.carry } : {}),
    ...(outcome.nextMode !== undefined ? { nextMode: outcome.nextMode } : {}),
  };
}
