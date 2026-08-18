// Public types for the conformance suite.

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  /** Stable identifier, e.g. "lifecycle.connect". */
  id: string;
  /** One-line human description. */
  description: string;
  status: CheckStatus;
  /** Short reason for fail/warn/skip; absent on ok. */
  message?: string;
  /** Wall-clock ms taken. */
  durationMs: number;
  /** Group key for the report, e.g. "lifecycle" / "simple-round" / "events". */
  group: string;
}

export interface ConformanceReport {
  adapter: {
    /** Best-effort label, pulled from adapter.diagnostics.adapter or a fallback. */
    name: string;
    version: string;
  };
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  checks: CheckResult[];
  /** Quick stats. */
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    skip: number;
  };
}

export interface ConformanceFixture {
  /** Stable session id used in checks. */
  sessionId: string;
  /** Stable connection id. */
  connectionId: string;
  /** Stake-multiplier-adjusted bet for simple-round checks. */
  bet: number;
  /** Bet index into the session's ladder. */
  betIndex: number;
  /** Price multiplier the orchestrator would pass to the platform. */
  priceMultiplier: number;
  /** A free-round pool already granted on the wallet for this session.
   *
   *  Optional, because granting one is a wallet-side action the suite cannot
   *  perform. Name it and the promo checks run; leave it out and they are
   *  reported as skips rather than passes - the pool countdown is the one place
   *  where a wallet's silence and a wallet's wrong answer have very different
   *  consequences, so "not tested" must not read as "fine". */
  promo?: {
    /** Pool id, as the adapter surfaces it in `SessionInfo.promo.id`. */
    id: string;
  };
}

export const DEFAULT_FIXTURE: ConformanceFixture = {
  sessionId: "conformance-session-1",
  connectionId: "conformance-conn-1",
  bet: 100,
  betIndex: 2,
  priceMultiplier: 1,
};
