---
"@open-rgs/core": minor
"@open-rgs/platform-mock": minor
---

**Stake multiplier now rides on `priceMultiplier`, not `bet`.**

A fractional `stakeMultiplier` like ante's 1.25× combined with a 1-unit
base bet used to throw `INVALID_BET: computed bet must be a non-negative
integer minor unit ... got 1.25` because the orchestrator folded stake
into bet (`base × priceMul × stake`), then asserted the result was an
integer minor unit (audit H1). Any game with a fractional stake was
unplayable.

Fix:
- `computeBet` now produces `bet = base × clientPriceMul` (integer
  minor units, audit H1 preserved). The mode's `stakeMultiplier` is no
  longer folded into bet.
- `effectiveCost = bet × stakeMultiplier` is exposed on the bet info
  + persisted on `OpenRound`, used for balance check, max-win cap input,
  win calculation (`settleAmount(multiplier, effectiveCost)`), and the
  audit log's "what was paid" semantic.
- The wire `priceMultiplier` passed to platforms remains
  `clientPriceMul × stakeMultiplier` (unchanged) — that's where the
  stake fold lives. Platforms (Artube et al.) compute their own debit
  at `bet × priceMultiplier` with currency-precision handling.
- `platform-mock` updated to debit `bet × priceMultiplier` (was just
  `bet`) so the bundled dev wallet honours the new semantics.

Wire-level changes for game integrators:
- `ClientResponseSpin.bet` is now `base × clientPriceMul` (was
  `base × clientPriceMul × stakeMultiplier`). Clients computing total
  cost should use `bet × priceMultiplier` from the mode catalog, or
  read it from a future explicit `cost` field.
- `SettleSimple.bet` / `OpenComplex.bet` likewise carry the stake-free
  integer value. Adapters that read `priceMultiplier` (already most of
  them) need no changes; adapters that read `bet` as cost must multiply
  by `priceMultiplier`.

Free-round modes (`stakeMultiplier: 0`) still debit 0 — effective cost
collapses correctly and the H4 funded-win guard still rejects winning
multipliers on a 0-cost mode.

Audit tests cover ante 1.25×, buy-mode 59×, and explicit-priceMul
composition (`priceMul=3` on a 1.25-stake ante → wire priceMultiplier
3.75).
