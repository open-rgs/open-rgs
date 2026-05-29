// The one money rounding boundary.
//
// Every monetary amount in @open-rgs/contract is an integer in the
// currency's minimal unit (ADR-002 — USD 1.00 → 100, BTC 1 sat → 1). A
// win, however, is a dimensionless `multiplier` (a float produced by math)
// times an integer `bet`, so `multiplier × bet` is generally fractional —
// e.g. `0.5 × 25 = 12.5`. Sending that to a wallet corrupts ledgers and
// fails reconciliation.
//
// ADR-002 fixes the rule at the win boundary as **round half to even**
// (banker's rounding): statistically unbiased over many rounds (ties go up
// and down equally, so no systematic drift toward house or player) and the
// convention regulators expect. This module is that single boundary; the
// orchestrator routes every settle amount through `settleAmount`.

import { RGSError } from "@open-rgs/contract";

/** Round to the nearest integer, ties to even (banker's rounding).
 *  `Math.round` rounds halves toward +∞ (0.5→1, 2.5→3), which is biased;
 *  this corrects the exact-tie case to the nearest even integer
 *  (0.5→0, 1.5→2, 2.5→2, 12.5→12). Works for any finite input. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  // Exact .5 tie → round to the even neighbour.
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Compute a settle amount in integer minor units from a dimensionless win
 *  `multiplier` and an integer `bet`. The multiplier must already be
 *  sanitized (finite, ≥ 0 — the orchestrator's max-win cap does this). The
 *  result is asserted to be an integer before it can reach a settle call,
 *  per ADR-002. */
export function settleAmount(multiplier: number, bet: number): number {
  const win = roundHalfEven(multiplier * bet);
  if (!Number.isInteger(win)) {
    // Only reachable if a caller skipped multiplier sanitization or passed
    // a non-finite bet — fail closed rather than settle a bad amount.
    throw new RGSError("INTERNAL_ERROR", "computed win is not an integer minor unit");
  }
  return win;
}
