// Promo free-rounds manager: core-side handling of platform-granted
// bonus rounds.
//
// The platform adapter tells us whether a session has an active promo
// pool at openSession() time, and pushes "promoGranted" events when a
// new pool appears upstream. This module owns the "is the promo active
// for this round?" decision and forces the right bet override when it
// is. Everything else about bonus engines (campaigns, jackpots, etc.)
// lives on the platform side — see specs/05-platform-protocol.md.

import type { LocalSession } from "./session.js";
import { log } from "./log.js";

/** Mark the promo offer as shown so we don't re-prompt. */
export function markOffered(s: LocalSession): void {
  if (s.promo) s.promo.offered = true;
}

/** Player accepts the promo — activate it. */
export function activate(s: LocalSession): boolean {
  if (!s.promo || s.promo.remaining <= 0 || s.promo.active) return false;
  s.promo.active = true;
  s.promo.offered = true;
  return true;
}

/** Player declines — mark offered so we don't ask again. */
export function decline(s: LocalSession): void {
  if (!s.promo) return;
  s.promo.offered = true;
  s.promo.active = false;
}

/** Returns the promo-locked bet override if a pool is active for this
 *  session and the mode (if filtered) is eligible. */
export function activeOverride(s: LocalSession, modeId?: string): { promoId: string; bet: number } | undefined {
  if (!s.promo?.active || s.promo.remaining <= 0) return undefined;
  if (s.promo.modeFilter && modeId && !s.promo.modeFilter.includes(modeId)) return undefined;
  return { promoId: s.promo.id, bet: s.promo.bet };
}

/** Apply post-round update from the adapter. Removes the pool when
 *  drained. */
export function applyUpdate(s: LocalSession, u: { remaining: number }): void {
  if (!s.promo) return;
  s.promo.remaining = u.remaining;
  if (u.remaining <= 0) {
    log.info("Promo pool drained", {
      "event.category": "promo",
      "session.id": s.sessionId,
      "promo.id": s.promo.id,
    });
    s.promo = undefined;
  }
}
