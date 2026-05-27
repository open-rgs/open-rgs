# ADR 002 — Integer minor units for amounts

**Status:** Accepted
**Date:** 2026-05-08

## Context

Money amounts cross the contract boundary in `SettleSimple`,
`OpenComplex`, `CloseComplex`, `SessionInfo`, etc. JavaScript's
`number` is a 64-bit float, which loses precision past 2^53 (~9e15)
and rounds non-binary fractions (0.1 + 0.2 ≠ 0.3). Wallets and
regulators care about exact amounts, especially for crypto where 8+
decimals are normal.

## Decision

Every monetary amount in `@open-rgs/contract` is an **integer in the
currency's minimal unit**. Examples:

- USD 1.00 → `100`
- EUR 0.05 → `5`
- BTC 0.00000001 → `1`
- JPY 100 → `100`

The session's currency comes from the adapter via `SessionInfo.currency`.
Per-currency precision (cents for USD, satoshis for BTC) is implicit
in the integer convention — RGS doesn't need a precision lookup.

## Consequences

**Upsides:**

- No float drift, no rounding bugs in the hot path.
- Integer arithmetic for `win = multiplier × bet` is fast and exact
  (subject to one float multiply if multiplier is non-integer; we
  truncate or round once at the boundary, not throughout).
- Adapters can persist as float in their own DB if they prefer; the
  conversion happens at the adapter boundary, not in core.
- Crypto-friendly out of the box — no special-cased "is this BTC?"
  logic.

**Costs:**

- Math files written by humans need to think in minor units. The
  examples and helpers will multiply manually (`bet = 100` for $1).
- The `multiplier × bet` calculation is float × int; we round to
  integer at the win boundary. Documented as "round half to even"
  to be regulator-friendly.
- Integrators who confuse minor-unit and decimal representation get
  100× errors. Loud at the type level (we type as `number` but
  document the convention; future improvement: brand the type).

## Alternatives considered

- **Decimal strings** (e.g., "1.00") — string ops are slow and
  error-prone, and arithmetic requires decimal-arithmetic library.
- **`bigint` everywhere** — accurate but verbose at JS sites; mixed
  arithmetic with float multipliers is awkward.
- **Per-currency precision lookup** — adds a stateful registry the
  contract has to know about; minor-unit convention sidesteps it.
- **Float with documented precision discipline** — works in theory,
  fails in practice on crypto and edge sums.
