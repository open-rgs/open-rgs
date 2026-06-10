# ADR 007  - Cross-pod resume via wallet-returned open round

**Status:** Accepted
**Date:** 2026-06-10

## Context

ADR-006 made the orchestrator stateless modulo an in-memory session
cache. The cost it recorded: a mid-complex-round session survives a
*disconnect* (same-pod resume from `LocalSession.openRound`) but not a
*process restart or pod move*  - the cache evaporates and Spec 02 said
"cross-process resume requires a wallet inquiry endpoint not yet
specified."

Meanwhile the contract already has the answer half-built:
`SessionInfo.openRound?: OpenRoundResume` exists on the
`wallet.openSession` return type. The gap is purely normative  - Spec 05
never required adapters to persist what's needed to populate it, so no
adapter does. This ADR closes that gap for v1.7.

## Decision

**1. Primary mechanism: the wallet returns the open round on
`openSession`.** No new RPC. A fresh INIT on *any* pod calls
`wallet.openSession` (Spec 02 fresh path); the adapter returns
`SessionInfo.openRound` when a complex round is open, and the
orchestrator re-hydrates `LocalSession.openRound` from it. To make that
possible, the wallet MUST persist alongside `openComplex`  - and keep
current via `updateComplex` checkpoints  - the round id, bet, mode, and
initial/last state checkpoint, clearing on `closeComplex`. Normative
wording lives in Spec 05 §"Open-round persistence & resume (v1.7)".

This keeps ADR-006 intact: the wallet was already the source of truth
for money and carry (ADR-004); it now also answers "is a round open?"
Correctness needs **no shared store** and no sticky routing.

**2. No separate `getOpenRound(sessionId)` inquiry method.**
`openSession` *is* the inquiry  - one RPC, one source of truth, no
second round-trip on the INIT hot path. This resolves the open
questions in Specs 02 and 05.

**3. `SessionStore` stays a deferred, optional peer package**
(e.g. `@open-rgs/session-store-redis`  - future, not committed). It is a
latency optimization for operators who want fast same-state failover of
the in-memory cache, never a correctness requirement. Sketch, to be
added to `@open-rgs/contract` only when an implementation ships:

```ts
interface SessionStore {
  get(sid: string): Promise<StoredSession | undefined>;
  put(sid: string, s: StoredSession, ttlMs?: number): Promise<void>;
  touch(sid: string, ttlMs?: number): Promise<void>;  // extend TTL on activity
  delete(sid: string): Promise<void>;
}
interface StoredSession {
  openRound?: OpenRoundResume & { state: RoundState };
  carry?: CarryState;
  nextMode?: string;
  balanceSeq: number;  // monotonic fence  - reject stale balance writes
}
```

TTL semantics: an expired entry is a **cache miss** (fall through to
wallet-driven resume), never an autoclose trigger (ADR-003 stands).
Implementation is **deferred** (KISS): wallet-driven resume already
covers correctness, and a store adds an infra dependency core has
avoided so far  - no Redis to operate, back up, or fail over. We record
the shape now so the future package can't drift into being a second
source of truth.

**4. Autoclose is reduced, not removed.** Wallet-driven resume rescues
the round whose player *comes back*. The round whose player never
returns still needs the Spec 05 autoclose backstop (wallet deadline,
`sessionClosed` cascade, or adapter-derived deadline). That hard
conformance requirement is unchanged.

## Consequences

**Upsides:**

- Cross-pod and post-restart resume with zero new infrastructure; any
  LB, no stickiness needed for correctness.
- One persistence rule for adapters, enforced by the conformance suite
  (`@open-rgs/adapter-test-kit`) once v1.7 lands.
- The `SessionStore` shape is recorded before anyone builds it wrong.

**Costs:**

- Adapters take on a persistence duty (most wallets already store open
  rounds for their own books; this codifies it). Marked v1.7  -
  adapters MAY omit until then, and `manifest.recovery.onRestart`
  applies as before.
- Degraded resume fidelity cross-pod: ops never cross the wallet
  boundary (Spec 05 §"What the wallet does NOT see"), so a
  wallet-built `OpenRoundResume` MAY carry empty `ops`/`actionLog`.
  Full-fidelity replay remains a same-pod feature; v1.7
  implementation may add an optional math hook to regenerate render
  ops and the `awaiting` hint from a state checkpoint.

## Alternatives considered

- **Dedicated `wallet.getOpenRound(sessionId)` RPC.** A second call on
  every INIT, and two ways to ask one question. `openSession` already
  returns `SessionInfo`; the field exists. Rejected.
- **Mandatory shared session store (Redis) for resume.** Correctness
  would then depend on infra core has never required; store-vs-wallet
  divergence becomes a new bug class. Violates ADR-006. Rejected as a
  requirement; kept as the optional cache above.
- **Sticky sessions as the whole answer.** Helps reconnects, does
  nothing for pod death or rolling restarts, and pushes a routing
  requirement onto every operator. Rejected.
