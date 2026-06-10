# Spec 02  - Orchestrator

## Goal

The orchestrator is the round-lifecycle state machine. It receives
typed requests from a transport, resolves which math runs, computes the
bet, mediates math <-> wallet, and produces typed responses. It owns no
durable state.

## Inputs / outputs

Inputs:
- Typed requests via `OrchestratorAPI` (called from transports).
- `PlatformEvent` stream from the configured `PlatformAdapter`.
- `AutocloseRequest` from external triggers (admin HTTP, wallet events).

Outputs:
- Typed responses via the `OrchestratorAPI` return values.
- Side effects: wallet RPCs (`settleSimple`/`openComplex`/`closeComplex`/
  `updateComplex`).
- Mutations to the in-memory `LocalSession` cache.

## Per-method behaviour

### `init(req, conn)`

1. Reject if `wallet.isHealthy === false` -> `PLATFORM_UNAVAILABLE`.
2. **Resume path**: if a `LocalSession` for `req.sid` already exists
   AND has `openRound`, reuse it. No second `wallet.openSession` call.
   Build `resume` payload from `openRound.opsLog` + `actionLog` +
   `awaiting`.
3. **Fresh path**: call `wallet.openSession(sid, conn.connectionId)`.
   Build `LocalSession` from the returned `SessionInfo`. Include any
   pending promo offer; mark it as offered to prevent re-prompt on the
   same connection.
4. Build `ClientResponseInit` with: balance, currency, allowedBets,
   defaultBetIndex, mode catalog (excluding `internal: true`),
   optional promo offer, optional resume payload.

### `spin(req, conn)`  - simple round

1. Look up session.
2. Resolve mode: promo override -> `session.nextMode` -> `req.mode` ->
   `manifest.defaultMode`.
3. Validate the resolved mode is `kind: "simple"`. Otherwise
   `INVALID_MODE`.
4. Compute bet: `allowedBets[betIndex] x priceMultiplier x stakeMultiplier`.
   promo active -> use promo-locked bet, force priceMultiplier=1.
5. Pre-flight balance check (skipped for promo). Insufficient ->
   `INSUFFICIENT_BALANCE`.
6. Call `math.play(session.carry, ctx)`. `ctx` is `{ mode, cheat?, params? }`.
7. **Sanitize + cap the multiplier**, then compute `win = multiplier x bet`.
   The multiplier is the only untrusted value crossing into money, so it
   is validated fail-closed *before* the cap: a non-finite multiplier
   (`NaN` / `+/-Infinity`) is a math fault and fails the round (never a
   payout); a negative multiplier is clamped to `0`; a multiplier above
   `maxWinMultiplier` is clipped and the outcome stamped
   `max_win_reached`.
8. Call `wallet.settleSimple({ bet, betIndex, priceMultiplier, win,
   multiplier, type, roundState: outcome.carry ?? "", promoId? })`.
9. On wallet success: update local balance, store `outcome.carry` and
   `outcome.nextMode` on the session, apply any promo update from the
   receipt.
10. Build `ClientResponseSpin` with `outcome.ops` forwarded as-is.

### `openRound(req, conn)`  - complex round / debit

1. Look up session. Reject if `session.openRound` exists ->
   `ROUND_ALREADY_OPEN`.
2. Resolve mode (same as spin); require `kind: "complex"`.
3. Compute bet (same as spin).
4. Pre-flight balance.
5. Call `math.open(session.carry, ctx)`. Math returns `{ state, ops,
   awaiting? }`.
6. Call `wallet.openComplex({ bet, betIndex, priceMultiplier,
   initialState: open.state, promoId? })`.
7. Stash an `OpenRound` on the session: `{ roundId, modeId, bet, state,
   awaiting?, actionLog: [], opsLog: [...open.ops], openedAt: now }`.
8. Build `ClientResponseOpenRound`.

### `stepRound(req, conn)`  - pure in-process

1. Look up session and its `openRound`. Reject if missing ->
   `NO_ROUND_OPEN`.
2. **Validate action against awaiting**: if `openRound.awaiting?.type`
   is set and doesn't match `req.action.type`, reject with
   `INVALID_ACTION`. Math is never invoked with bad input.
3. Look up the mode (cached from `openRound.modeId`).
4. Call `math.step(state, action)`. Math returns `{ state, ops, awaiting? }`.
5. Update `openRound`: replace state, set/delete awaiting, append
   action to `actionLog`, append ops to `opsLog`.
6. Record the action into the tamper-evident game-cycle audit log (kind
   `step`), and checkpoint to the wallet if `wallet.updateComplex` is
   defined. The checkpoint honours `auditMode`: `best-effort` (default)
   fires it and swallows failures; `mandatory` awaits it and **fails the
   step** (`STEP_FAILED`) if dropped  - for jurisdictions that require a
   server-side action log, where a missing record can't be "best effort".
7. **No money moves.** Build `ClientResponseStepRound` with `ops` and
   `awaiting?`.

### `closeRound(req, conn)`  - credit

1. Look up session and its `openRound`. Reject if missing.
2. Confirm `math.isTerminal(state) === true`. Otherwise `INVALID_ROUND`.
3. Call `math.close(state)`. Math returns `{ multiplier, ops, type,
   carry?, nextMode? }`.
4. Sanitize + cap the multiplier (same fail-closed rules as `spin` step 7),
   then compute `win = multiplier x bet`.
5. Call `wallet.closeComplex({ roundId, finalState: state, win,
   multiplier, type })`.
6. On success: update balance, set carry/nextMode for next round, apply
   promo update if any. Drop `openRound`.
7. Build `ClientResponseCloseRound`.

### `promoAccept(req, conn)`  - promo accept/decline

1. Look up session.
2. No promo offer or completed -> `{ ok: false }`.
3. `req.accept === false` -> mark declined, return `{ ok: true }`.
4. `req.accept === true` -> activate promo, return `{ ok: true, promo: {...} }`.

### `autocloseRound(req)`  - external trigger

Documented in detail in **Spec 02 §Autoclose** below.

### `onDisconnect(conn)`

1. If session has `openRound` -> KEEP the session in cache (resume on
   reconnect needs it).
2. Else -> drop the session entry.

## Mode resolution rule

Always evaluated in this order, first match wins:

1. **promo active** (`session.promo?.active === true`): force the manifest's
   `defaultMode` at the promo's locked bet.
2. **Math `nextMode` override** (`session.nextMode` set by previous
   round's outcome): use it.
3. **Client request** (`req.mode`): use if non-empty.
4. **Manifest default** (`manifest.defaultMode`): fallback.

## Bet computation

```
bet = allowedBets[betIndex] x priceMultiplier x stakeMultiplier
```

- `allowedBets`: per-session, from `SessionInfo`.
- `betIndex`: from client, validated against array length.
- `priceMultiplier`: from client, defaults to 1.
- `stakeMultiplier`: from manifest's mode entry. 80 for buy-fs, etc.

The orchestrator passes `betIndex` and `priceMultiplier x stakeMultiplier`
to the wallet so adapters can preserve their native (index, multiplier)
audit trail.

### Free-round funding

`win = multiplier x bet`, so a `stakeMultiplier: 0` mode has `bet = 0` and any
win would settle to **0**  - silently losing the payout. The orchestrator
forbids this: a 0-bet round that produces a winning multiplier fails with
`INVALID_BET`. Free rounds must therefore be funded so the bet is non-zero:

- **Promo pool**  - a `PromoFreeRounds` pool locks a non-zero bet for the
  round (`computeBet` uses the pool's bet, not `stakeMultiplier x 0`); the
  win pays normally and the pool decrements.
- **Carry into the parent**  - a game-triggered feature accumulates its
  winnings into the triggering round's `carry` and pays them at that round's
  close (the triggering paid spin owns the feature EV).

A 0-bet round that *loses* (multiplier 0) is fine  - it settles 0, as a free
spin that didn't win should.

## Autoclose

Autoclose is **strictly externally-triggered**. The orchestrator does
NOT run idle timers. Three triggers:

1. **PlatformEvent** `{ type: "autocloseRequested", sessionId, roundId?, reason }`.
2. **Implicit cascade**: `PlatformEvent` `{ type: "sessionClosed", ... }`
   when the session has an `openRound` triggers an autoclose first.
3. **Admin HTTP** `POST /api/autoclose` calls
   `orchestrator.autocloseRound()` directly.

The autoclose flow honours the game's `manifest.autoclose.policy`
(default `math-decides`):

1. Look up session and `openRound`. Validate optional `roundId` matches.
2. **`hold`** -> don't autoclose; return `{ closed: false, reason:
   "policy-hold" }` and leave the round open for later resolution.
3. **`settle-as-loss`** -> settle a zero-multiplier loss (explicit forfeit).
4. Otherwise (`math-decides` / `settle-at-current`): call `math.autoclose(
   state)` if implemented; else if `math.isTerminal(state)`, call
   `math.close(state)`.
5. If neither produced an outcome:
   - **`settle-at-current`** -> **refuse** (`{ closed: false }`): the policy
     needs a valuation the math didn't provide, and we must NOT silently
     forfeit banked player value. The round stays open and the
     misconfiguration is logged at error level.
   - **`math-decides`** -> zero-multiplier loss (conservative; no surprise
     pay-out from stale state).
6. Apply the same sanitize + max-win cap as a client close (autoclose
   moves money too, so it must not bypass the guard), then compute
   `win = multiplier x bet`. Call `wallet.closeComplex(...)`.
7. Update balance, drop `openRound`. Log with `event.category=autoclose`
   and the trigger reason.

A game that can leave value on the table (banked guaranteed winnings) MUST
either implement `math.autoclose(state)` or declare `settle-at-current`  -
otherwise an abandoned round is forfeited. Math's `autoclose(state)` is the
math-decided valuation  - "force-stand the dealer," "lock the gamble at
current pool," "settle the crash at last seen multiplier," etc.

## Resume on reconnect

Same-process: a player's `LocalSession` is retained across disconnects
when `openRound` exists. Next `init` for the same `sid` builds a resume
payload from in-memory state:

```ts
resume: {
  roundId, modeId, bet,
  ops: openRound.opsLog,           // cumulative  - replay to render
  actionLog: openRound.actionLog,  // history of player decisions
  awaiting?: openRound.awaiting,
  openedAt: openRound.openedAt,
}
```

Cross-process resume (after a server restart or pod move) is
wallet-driven: the fresh INIT's `wallet.openSession` returns
`SessionInfo.openRound`, and the orchestrator re-hydrates
`LocalSession.openRound` from it  - see **ADR-007** and Spec 05
§"Open-round persistence & resume" (v1.7; until adapters populate it,
restart-recovery operates per `manifest.recovery.onRestart`).

## Per-session serialization

The orchestrator is single-threaded, but every money operation `await`s
the math and the wallet, and an `await` yields the event loop. Two
operations targeting the **same session** could therefore interleave
across their awaits  - e.g. two spins both passing the `bet > balance`
check against the same stale balance (overspend), or a client `closeRound`
running concurrently with an `autocloseRound` and both calling
`closeComplex` (double credit).

To prevent this, the orchestrator serializes operations per session: each
of `init`, `spin`, `openRound`, `stepRound`, `closeRound`, `promoAccept`,
and `autocloseRound` (including event- and admin-triggered autoclose) runs
under a per-`sessionId` async queue, so at most one is in flight for a
session at a time. An operation runs start-to-finish  - including clearing
`session.openRound`  - before the next begins, so a close racing an
autoclose collapses to one credit (the second observes no open round). This
is the orchestrator-level guard; idempotency keys (deterministic per round
for closes  - see Spec 05) are the wallet-level backstop. Operations on
*different* sessions are unaffected and run concurrently.

The lock guards in-process ordering only; it is not a substitute for the
wallet being the source of truth across processes.

### Connection concurrency (`ConcurrencyPolicy`)

INIT arbitrates when the session is already attached to ANOTHER live
connection (`createServer({ concurrencyPolicy })`):

- **kick-old** (default): the older connection receives a
  `SESSION_IN_USE` error frame and is closed (app close code 4000); the
  new connection takes over. The player's newest window always wins  - two
  open windows never silently diverge.
- **reject-new**: the newer INIT fails with `SESSION_IN_USE`; the older
  connection stays attached.
- **allow**: both coexist (the pre-enforcement behaviour). Money stays
  safe under any policy  - the per-session lock and wallet idempotency
  hold regardless  - but coexisting windows see diverging balance views.

A connection that disconnects DETACHES from its session first, so a plain
reconnect after a drop is never policed: the policy only ever arbitrates
two live connections. A kicked connection's late close event is ignored
(it no longer owns the binding), so it cannot evict the new owner's
session. Enforcement needs the transport's optional `closeConnection`
capability for the kick; a custom transport without it degrades kick-old
to allow with a boot-time warning. Interventions are counted in
`rgs_session_concurrency_actions_total{action}`.

## Acceptance criteria

- Every public method returns within the latency budget in **Spec 06**
  for the synthetic test workload.
- Mode resolution always picks one of the four sources, with promo
  winning over `nextMode` winning over request winning over default.
- Mid-complex-round disconnection followed by reconnection within the
  same process produces an INIT response with a `resume` field
  containing the full action history.
- An `autocloseRequested` event arriving for an unknown session/round
  returns `{ closed: false, reason: ... }` and emits a warn-level log,
  not an error.
- A `sessionClosed` event for a session with an open round triggers
  autoclose-then-drop (verified via the wallet recording a CloseRound
  before the local session disappears).

## Open questions

- Multiple games in one process: **decided against** (not deferred).
  `createServer` takes one `manifest`  - one game per process  - and that
  is the intended shape: in-process multi-tenancy isn't worth the
  complexity (spec 10, "What we deliberately AVOID"). To run several
  games, run several processes (spec 07, "Multi-game deployments").
- Should we expose a "drain" mode (reject new INITs but let in-flight
  rounds finish) for graceful shutdown? **Pending.**
- ~~Cross-process resume needs a `wallet.getOpenRound(sessionId)`
  call.~~ **Decided  - no new call** (ADR-007): `openSession` is the
  inquiry; the wallet returns `SessionInfo.openRound`.
