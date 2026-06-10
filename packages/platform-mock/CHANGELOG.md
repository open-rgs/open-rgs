# @open-rgs/platform-mock

## 1.2.1

### Patch Changes

- Updated dependencies [[`0e82986`](https://github.com/open-rgs/open-rgs/commit/0e82986fa98e82bc6bf1df8904239f454c30ad56), [`c029ad3`](https://github.com/open-rgs/open-rgs/commit/c029ad37eb817e8b700d80c2691102e0c15a4a84)]:
  - @open-rgs/contract@1.2.0

## 1.2.0

### Minor Changes

- [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Add an optional `PlatformAdapter.reverseRound` for wallet-initiated reversal
  (chargeback / reconciliation), formalizing Guarantee 2 - "One Round, One
  Record" (`specs/00-guarantees.md`).

  A reversal MUST undo **both** halves of a round atomically - the balance delta
  AND the carry it produced - and is **latest-first**: only the most recent
  un-reversed round may be reversed, so reversing an older round can't restore a
  stale snapshot and silently over-refund the newer rounds on top of it. An
  unknown or already-reversed round is a safe no-op (`reversed: false`), never a
  double credit.

  - `@open-rgs/contract`: new optional method `reverseRound?(req: ReverseRound):
Promise<ReverseReceipt>` plus the `ReverseRound` / `ReverseReceipt` types.
    Additive and optional - existing adapters compile and run unchanged.
  - `@open-rgs/platform-mock`: the reference wallet now implements `reverseRound`
    correctly (per-session LIFO stack of pre-round balance+carry snapshots) and
    persists carry on settle so the whole-record property is real. The
    `safety.test.ts` suite proves whole-record reversal, out-of-order rejection,
    no-double-credit, and complex-round reversal.

  Spec: `specs/05-platform-protocol.md` gains a "Reversal" subsection.

### Patch Changes

- Updated dependencies [[`a414783`](https://github.com/open-rgs/open-rgs/commit/a41478386a0f2ba44dbf632405f73be0d0e105bc), [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc)]:
  - @open-rgs/contract@1.1.0

## 1.1.0

### Minor Changes

- [#80](https://github.com/open-rgs/open-rgs/pull/80) [`c9b0576`](https://github.com/open-rgs/open-rgs/commit/c9b05763c1e6e8f92ad68e72743c31ad8563e9b7) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **Stake multiplier now rides on `priceMultiplier`, not `bet`.**

  A fractional `stakeMultiplier` like ante's 1.25x combined with a 1-unit
  base bet used to throw `INVALID_BET: computed bet must be a non-negative
integer minor unit ... got 1.25` because the orchestrator folded stake
  into bet (`base x priceMul x stake`), then asserted the result was an
  integer minor unit (audit H1). Any game with a fractional stake was
  unplayable.

  Fix:

  - `computeBet` now produces `bet = base x clientPriceMul` (integer
    minor units, audit H1 preserved). The mode's `stakeMultiplier` is no
    longer folded into bet.
  - `effectiveCost = bet x stakeMultiplier` is exposed on the bet info
    - persisted on `OpenRound`, used for balance check, max-win cap input,
      win calculation (`settleAmount(multiplier, effectiveCost)`), and the
      audit log's "what was paid" semantic.
  - The wire `priceMultiplier` passed to platforms remains
    `clientPriceMul x stakeMultiplier` (unchanged) - that's where the
    stake fold lives. A wallet computes its own debit at
    `bet x priceMultiplier` with currency-precision handling.
  - `platform-mock` updated to debit `bet x priceMultiplier` (was just
    `bet`) so the bundled dev wallet honours the new semantics.

  Wire-level changes for game integrators:

  - `ClientResponseSpin.bet` is now `base x clientPriceMul` (was
    `base x clientPriceMul x stakeMultiplier`). Clients computing total
    cost should use `bet x priceMultiplier` from the mode catalog, or
    read it from a future explicit `cost` field.
  - `SettleSimple.bet` / `OpenComplex.bet` likewise carry the stake-free
    integer value. Adapters that read `priceMultiplier` (already most of
    them) need no changes; adapters that read `bet` as cost must multiply
    by `priceMultiplier`.

  Free-round modes (`stakeMultiplier: 0`) still debit 0 - effective cost
  collapses correctly and the H4 funded-win guard still rejects winning
  multipliers on a 0-cost mode.

  Audit tests cover ante 1.25x, buy-mode 59x, and explicit-priceMul
  composition (`priceMul=3` on a 1.25-stake ante -> wire priceMultiplier
  3.75).

## 1.0.0

### Major Changes

- [#72](https://github.com/open-rgs/open-rgs/pull/72) [`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - open-rgs 1.0.0 - first stable release.

  This release follows a full production-readiness audit; every Critical, High, Medium, and Low finding has been resolved. Highlights:

  - **Money math** is integer minor units end to end, rounded half-to-even at the single settle boundary, with safe-integer guards that fail loud instead of silently corrupting past 2^53 (ADR-002).
  - **Fairness & isolation**: RNG is injected and fail-closed in production; the Lua math runtime is sandboxed (denylisted globals, host-routed `math.random`) with an instruction-budget execution watchdog.
  - **Integrity**: stable per-round idempotency keys, per-session serialization, and a hash-chained tamper-evident audit log.
  - **Operations**: authenticated and network-isolatable admin surface, accurate `/healthz` versioning, frame-size limits, and value-level log redaction.
  - **Adapter contract**: the autoclose backstop is a hard conformance requirement and the conformance suite proves real idempotency/error-path safety.

  The public surface (`@open-rgs/contract` + `@open-rgs/core`) is now considered stable under semver. All eight `@open-rgs/*` packages move to 1.0.0 together for this milestone; subsequent releases version independently.

### Patch Changes

- Updated dependencies [[`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29)]:
  - @open-rgs/contract@1.0.0
