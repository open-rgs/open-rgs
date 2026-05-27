# ADR 006  - RGS is stateless modulo session cache

**Status:** Accepted
**Date:** 2026-05-08

## Context

Two extremes for state ownership:
- **Stateful RGS:** RGS holds durable state (DB, Redis, etc.) and is
  the source of truth.
- **Stateless RGS:** RGS holds nothing durable; can be killed and
  restarted with no data loss.

ADR 004 already established that math state is owned by the adapter.
This ADR extends that principle to the entire orchestrator: nothing
durable lives in core.

## Decision

The orchestrator owns no durable state. Specifically:

- `LocalSession` is an in-memory `Map<sid, ...>` rebuilt from
  `wallet.openSession` on every fresh INIT.
- `ECS log ring` (last 2000 entries) is in-memory only. Production
  log shipping happens via stdout -> external collector.
- `Diagnostics counters` are in-memory only. Lost on restart.
- `In-flight complex round state` is held in `LocalSession.openRound`
  in memory; on disconnect, the session is retained for resume; on
  process restart, the session evaporates and recovery policy
  applies (see manifest's `recovery.onRestart`).

Multi-pod session coherence is **NOT solved by the RGS**. If an
operator runs N replicas behind a load balancer:
- Sticky sessions are recommended for fast same-pod reconnect.
- Multi-pod resume requires either operator-managed sticky-session
  routing OR an optional `RedisSessionStore` peer package (planned,
  not committed).

## Consequences

**Upsides:**

- N replicas behind any LB; no sticky requirement for correctness,
  only for performance.
- No DB to operate, back up, replicate, or migrate.
- K8s rolling restarts are "kill, restart, sessions re-INIT
  themselves"  - short blip, no data loss because there was nothing
  to lose.
- GDPR-light by construction: no PII at rest in the RGS.
- Easy to reason about: one process, one Map, one orchestrator.

**Costs:**

- Cross-process complex-round resume needs the wallet to expose an
  open-round inquiry (planned in `PlatformAdapter` v2).
- Operators with high-availability requirements need to invest in
  their own session-coherence story (Redis, sticky sessions, both).
- Some metrics are pod-local; aggregated dashboards need to scrape
  per-pod and combine.

## Alternatives considered

- **RGS-owned Redis state.** Adds a service dependency, sync issues,
  failover complexity. The wallet is already authoritative; doubling
  state is rot bait.
- **Sqlite-per-pod.** Survives restart but loses on pod move. Worst
  of both worlds.
- **Stateful single-instance "leader" pattern.** Defeats horizontal
  scaling. Rejected.

## Notes

- An optional `@open-rgs/session-store-redis` peer package is on the
  roadmap. If it ships, it slots in via a `SessionStore` interface
  abstraction to be added to `@open-rgs/contract`. The default
  remains in-memory.
- This ADR may be partially superseded if multi-pod resume becomes
  a hard requirement; we'd factor `LocalSession` storage behind an
  interface and ship a Redis impl. Still wouldn't be stateful by
  default.
