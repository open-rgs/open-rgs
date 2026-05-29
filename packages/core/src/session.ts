// In-memory session store. The platform adapter is the source of truth;
// LocalSession is a transient cache rebuilt on every INIT.

import type { CarryState, RoundState, AwaitingHint, Op, PromoFreeRounds } from "@open-rgs/contract";

export interface LocalPromo {
  /** Opaque pool id surfaced from the adapter. */
  id: string;
  /** Per-round bet locked by the pool (integer minor units). */
  bet: number;
  /** Rounds remaining in the pool. Decremented by orchestrator as
   *  rounds are consumed; pool is removed when this hits 0. */
  remaining: number;
  /** Optional mode whitelist — pool consumable only in these modes. */
  modeFilter?: string[];
  /** Optional UX hint surfaced to the client. */
  label?: string;
  /** Optional UX hint — total rounds originally granted. */
  total?: number;
  /** Optional UX hint — ISO expiry. */
  validTo?: string;
  /** True once the player has accepted the offer on this connection. */
  active: boolean;
  /** True once the player has been shown the offer (so we don't ask twice). */
  offered: boolean;
}

export interface OpenRound {
  roundId: string;
  modeId: string;
  bet: number;
  state: RoundState;
  awaiting?: AwaitingHint;
  /** Action log for replay-on-reconnect. */
  actionLog: { type: string; [k: string]: unknown }[];
  /** Cumulative ops for resume-on-reconnect. */
  opsLog: Op[];
  /** Wall-clock ms epoch when the round opened. */
  openedAt: number;
}

export interface LocalSession {
  readonly sessionId: string;
  readonly connectionId: string;
  balance: number;
  readonly currency: string;
  readonly currencyDecimals: number;
  readonly allowedBets: number[];
  readonly defaultBetIndex: number;
  /** Math-owned blob threaded across rounds on this session. */
  carry?: CarryState;
  /** Mode override produced by previous round's math output. */
  nextMode?: string;
  /** In-flight complex round, if any. */
  openRound?: OpenRound;
  promo?: LocalPromo;
  /** Highest balanceChanged event seq applied (see PlatformEvent.seq). Used
   *  to drop out-of-order/duplicate balance events. */
  balanceSeq?: number;
  readonly createdAt: number;
}

const sessions = new Map<string, LocalSession>();

/** Soft cap on cached sessions. On overflow the oldest IDLE sessions (no
 *  open round) are evicted — their balance cache is rebuilt on next INIT.
 *  Sessions with an open round are NEVER evicted (a debited stake + resume
 *  state are outstanding); bounding *those* needs a wallet autoclose backstop
 *  (see specs/07 + the autoclose section of specs/02). */
export const MAX_CACHED_SESSIONS = 50_000;

export function promoFromApi(p: PromoFreeRounds): LocalPromo {
  const local: LocalPromo = {
    id: p.id,
    bet: p.bet,
    remaining: p.remaining,
    active: false,
    offered: false,
  };
  if (p.modeFilter !== undefined) local.modeFilter = p.modeFilter;
  if (p.label !== undefined)      local.label      = p.label;
  if (p.total !== undefined)      local.total      = p.total;
  if (p.validTo !== undefined)    local.validTo    = p.validTo;
  return local;
}

export function put(s: LocalSession): void {
  sessions.set(s.sessionId, s);
  if (sessions.size > MAX_CACHED_SESSIONS) evictIdleOverflow();
}
export function get(id: string): LocalSession | undefined { return sessions.get(id); }
export function remove(id: string): void { sessions.delete(id); }
export function all(): readonly LocalSession[] { return [...sessions.values()]; }
export function size(): number { return sessions.size; }

/** Evict the oldest IDLE (no open round) sessions down to a low-water mark.
 *  Returns the number evicted. */
function evictIdleOverflow(): number {
  const lowWater = Math.floor(MAX_CACHED_SESSIONS * 0.9);
  const idle = [...sessions.values()]
    .filter((s) => !s.openRound)
    .sort((a, b) => a.createdAt - b.createdAt);
  let removed = 0;
  for (const s of idle) {
    if (sessions.size <= lowWater) break;
    sessions.delete(s.sessionId);
    removed++;
  }
  return removed;
}

/** Operational snapshot of in-flight (open) rounds — for /healthz so the
 *  count of debited-but-unclosed rounds is observable (audit M6). */
export function openRoundStats(now: number): { open_rounds: number; oldest_open_round_age_ms: number } {
  let count = 0;
  let oldestOpenedAt = now;
  for (const s of sessions.values()) {
    if (s.openRound) {
      count++;
      if (s.openRound.openedAt < oldestOpenedAt) oldestOpenedAt = s.openRound.openedAt;
    }
  }
  return { open_rounds: count, oldest_open_round_age_ms: count > 0 ? now - oldestOpenedAt : 0 };
}

export function setBalance(id: string, balance: number): void {
  const s = sessions.get(id);
  if (s) s.balance = balance;
}

export function setCarry(id: string, carry?: CarryState, nextMode?: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.carry = carry;
  s.nextMode = nextMode;
}
