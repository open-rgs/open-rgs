# ADR 002  - Integer minor units for amounts

**Status:** Accepted
**Date:** 2026-05-08

## Context

Money amounts cross the contract boundary in `SettleSimple`,
`OpenComplex`, `CloseComplex`, `SessionInfo`, etc. JavaScript's
`number` is a 64-bit float, which loses precision past 2^53 (~9e15)
and rounds non-binary fractions (0.1 + 0.2 != 0.3). Wallets and
regulators care about exact amounts, especially for crypto where 8+
decimals are normal.

## Decision

Every monetary amount in `@open-rgs/contract` is an **integer in the
currency's minimal unit**. Examples:

- USD 1.00 -> `100`
- EUR 0.05 -> `5`
- BTC 0.00000001 -> `1`
- JPY 100 -> `100`

The session's currency comes from the adapter via `SessionInfo.currency`.
Per-currency precision (cents for USD, satoshis for BTC) is implicit
in the integer convention  - RGS doesn't need a precision lookup.

## Consequences

**Upsides:**

- No float drift, no rounding bugs in the hot path.
- Integer arithmetic for `win = multiplier x bet` is fast and exact
  (subject to one float multiply if multiplier is non-integer; we round
  once at the boundary  - half to even, see below  - not throughout).
  Implemented in `@open-rgs/core`'s `settleAmount` (`money.ts`).
- Adapters can persist as float in their own DB if they prefer; the
  conversion happens at the adapter boundary, not in core.
- Crypto-friendly out of the box  - no special-cased "is this BTC?"
  logic.

**Costs:**

- Math files written by humans need to think in minor units. The
  examples and helpers will multiply manually (`bet = 100` for $1).
- The `multiplier x bet` calculation is float x int; we round to
  integer at the win boundary. Documented as "round half to even"
  to be regulator-friendly.
- Integrators who confuse minor-unit and decimal representation get
  100x errors. Loud at the type level (we type as `number` but
  document the convention; future improvement: brand the type).
- A `number` minor unit is exact only up to `Number.MAX_SAFE_INTEGER`
  (2^53 − 1 ~= 9.007e15). Past that, integers silently lose precision
   - see "The 2^53 ceiling" below.

## The 2^53 ceiling (safe-integer guard)

`number` holds every integer exactly up to `2^53 − 1`; beyond that the
representable integers thin out (2^53 + 1 is not representable) and an
amount would be silently corrupted. For the currencies/limits this RGS
targets  - fiat in cents, crypto where stake and win sit far below the
ceiling  - 9e15 minor units is comfortably out of range (that's ~90
trillion USD, or ~90M BTC in satoshis). But "comfortable" is not
"guaranteed": a misconfigured currency precision, a runaway multiplier,
or an aggregate counter can cross it.

The decision is to **fail loud, not corrupt silently**. Every amount is
required to be a *safe* integer (`Number.isSafeInteger`), and the two
boundaries enforce it:

- `@open-rgs/core` `money.ts`  - `assertSafeAmount` guards `settleAmount`
  and is reused for balances; a win past the safe range throws
  `INTERNAL_ERROR` rather than reaching a wallet. The orchestrator's
  computed-bet check likewise uses `Number.isSafeInteger`.
- `@open-rgs/adapter-kit` `currency.ts`  - `fromWireAmount` rejects any
  wire value that converts to an unsafe integer (a high-decimal
  currency or huge balance), so corruption is caught at the adapter
  boundary, not deep in the ledger.

If a deployment genuinely needs amounts past 2^53, the fix is `bigint`
money (see Alternatives), not relaxing the guard.

## Alternatives considered

- **Decimal strings** (e.g., "1.00")  - string ops are slow and
  error-prone, and arithmetic requires decimal-arithmetic library.
- **`bigint` everywhere**  - accurate at any magnitude but verbose at JS
  sites; mixed arithmetic with float multipliers is awkward (a win is
  `multiplier x bet`, float x int). Deferred, not rejected: it is the
  designated path if a deployment ever needs amounts past 2^53. Until
  then the safe-integer guard (above) makes the limit explicit instead
  of silent.
- **Per-currency precision lookup**  - adds a stateful registry the
  contract has to know about; minor-unit convention sidesteps it.
- **Float with documented precision discipline**  - works in theory,
  fails in practice on crypto and edge sums.
