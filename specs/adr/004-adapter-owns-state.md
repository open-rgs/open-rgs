# ADR 004 — Adapter owns state, RGS is pass-through

**Status:** Accepted
**Date:** 2026-05-08

## Context

Math state threads across rounds via `carry` (cross-round) and within
complex rounds via `state` (per-round). Someone has to persist these
between server restarts and across reconnects. Two candidates:

- **RGS** keeps a durable store (Redis, sqlite, whatever).
- **The platform adapter** keeps it, since the wallet already persists
  round-state for audit purposes.

## Decision

The **adapter is the source of truth** for math state.

Concretely:

- `SessionInfo.carry` (returned by adapter on `openSession`) carries
  the prev cross-round carry for this session/player. RGS uses it to
  seed the next round.
- `SettleSimple.roundState` carries new state to the wallet on close.
- `OpenComplex.initialState` carries the round's opening state.
- `CloseComplex.finalState` carries the round's closing state.
- `CloseComplex.carry` carries the cross-round carry to thread next.
- `SessionInfo.mathVersion`, `SettleSimple.mathVersion`, etc. carry
  the math version stamp so RGS can detect post-patch incompatibility.

RGS keeps `LocalSession.carry` in memory across rounds within a
session for performance. On disconnect-and-reconnect the cache
evaporates and is rebuilt from `SessionInfo.carry` returned by
the adapter.

## Consequences

**Upsides:**

- RGS is genuinely stateless (modulo the in-memory cache). No
  database in core. K8s rolling restarts are cheap.
- Wallets already keep audit trails of round state — we leverage
  that instead of duplicating.
- Operators can swap RGS instances at will; whichever pod the next
  player request lands on rebuilds the session from the wallet.
- Cross-server-version migration: the wallet's audit log is the
  durable record, so re-deploying with a new math version that reads
  old state means the old state passes through the adapter
  unchanged.

**Costs:**

- One extra round-trip on every fresh INIT to fetch carry from the
  wallet (already needed for balance + game settings, so marginal).
- Adapters must explicitly persist `roundState` / `carry` /
  `mathVersion`. Walked through in spec 05.
- Wallets that don't expose a "fetch open round state" endpoint
  can't support cross-process resume. Documented as a wallet
  capability.

## Alternatives considered

- **RGS-side persistence (Redis or sqlite).** Adds a second store of
  truth, sync issues, deployment complexity. Rejected.
- **In-memory only, no persistence.** Works for short-lived sessions
  but breaks resume-after-restart and breaks any session that
  spans pod-evictions.
- **Math owns persistence (e.g., math reads its own DB).** Breaks the
  pure-function property of math; vetoed.
