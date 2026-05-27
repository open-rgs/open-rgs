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
  readonly createdAt: number;
}

const sessions = new Map<string, LocalSession>();

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

export function put(s: LocalSession): void { sessions.set(s.sessionId, s); }
export function get(id: string): LocalSession | undefined { return sessions.get(id); }
export function remove(id: string): void { sessions.delete(id); }
export function all(): readonly LocalSession[] { return [...sessions.values()]; }
export function size(): number { return sessions.size; }

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
