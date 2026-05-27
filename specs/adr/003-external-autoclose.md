# ADR 003 — External-triggered autoclose, no in-process timers

**Status:** Accepted
**Date:** 2026-05-08

## Context

Complex rounds open and stay open until the player closes them or
a deadline expires. The natural reflex is to run an idle timer
in the RGS that fires autoclose after N minutes. But that puts
policy in the wrong place — the wallet/operator owns "when has this
session been idle long enough to settle?" not the game server.

## Decision

The orchestrator does **not run idle timers**. Autoclose is always
triggered by an external signal. Three entry points:

1. **PlatformEvent** `{ type: "autocloseRequested", sessionId, roundId?,
   reason }` pushed by the platform adapter.
2. **Implicit cascade** when the wallet emits `sessionClosed` and the
   session has an open round — orchestrator autocloses first, then
   drops the local cache.
3. **Admin HTTP** `POST /api/autoclose` for operator scripts.

The math may implement an optional `autoclose(state)` resolver to
decide what the autoclose outcome should be (e.g. "force-stand the
dealer," "lock the gamble at current pool"). Without a math-defined
resolver, RGS closes with multiplier 0.

## Consequences

**Upsides:**

- Policy lives where it belongs (operator/wallet).
- RGS stays simple — no scheduler, no per-session timer leak risk,
  no time-zone bugs.
- Same code path on K8s rolling restart: when wallet says "close it,"
  RGS closes; when it doesn't, the round stays open until a real
  signal arrives.
- Easy to test: trigger the event, observe the close.

**Costs:**

- Wallets that don't naturally emit "close this round" events need
  the adapter to derive one (e.g., from a `sessionClosed` cascade).
- Operator must run their own scheduling for "this round has been
  open 30 minutes, time to autoclose" if their wallet doesn't do it.

## Alternatives considered

- **In-process idle timer.** Easy to write, wrong layer. Operators
  often want different policies per jurisdiction; a hard-coded
  RGS-side timer would either be the wrong default or require a
  config knob that grows over time.
- **Heartbeat-based autoclose** ("if client doesn't ping in 60s,
  autoclose"). Conflates connection-liveness with round-liveness.
  Player tabs sleep; round shouldn't.
- **Math-driven autoclose** ("math has its own clock, decides when
  to autoclose"). Requires math to have access to time, which we
  don't want — pure-function math is a property worth preserving.
