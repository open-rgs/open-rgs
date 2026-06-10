# Spec 05  - Wallet Protocol

## Goal

Specify what every `PlatformAdapter` implementation must do, so that the
orchestrator stays operator-agnostic and so that swapping adapters is a
deployment-time concern.

## The contract restated

```ts
interface PlatformAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  readonly isHealthy: boolean;
  readonly diagnostics: Record<string, unknown>;

  openSession(sessionId: string, connectionId: string): Promise<SessionInfo>;

  settleSimple(req: SettleSimple): Promise<RoundReceipt>;

  openComplex(req: OpenComplex): Promise<RoundReceipt>;
  updateComplex?(req: UpdateComplex): Promise<void>;
  closeComplex(req: CloseComplex): Promise<RoundReceipt>;

  onEvent(handler: (e: PlatformEvent) => void): void;
}
```

## Required guarantees

### Currency precision

`SessionInfo.currencyDecimals` is **required**  - every adapter MUST
populate it from the upstream platform (config, DB, openSession
response, wherever the provider exposes it). EUR/USD/RUB = 2,
JPY/HUF = 0, BTC = 8.

The contract requires every `balance`, `bet`, `win`, and amount on
this interface to be an **integer in the currency's minimal unit**
(USD 1.00 -> 100 when `currencyDecimals = 2`). The orchestrator never
converts amounts  - math operates on integers throughout. Adapters
facing platforms that expect decimal strings or floats on the wire
convert at their outbound boundary; `@open-rgs/adapter-kit/currency`
provides `toWireAmount` / `fromWireAmount` helpers with explicit
rounding modes.

### Money movement

| Method | Effect |
|--------|--------|
| `settleSimple` | Atomically debit `bet` and credit `win`. Single transaction. |
| `openComplex` | Debit `bet`. Returns `roundId` referenceable by close/update. |
| `updateComplex` | NO money movement. Pure audit/state-persistence. Idempotent. |
| `closeComplex` | Credit `win` against the open round. Final transaction. |
| `reverseRound` | OPTIONAL. Undo a settled round  - money AND carry  - latest-first. |

The orchestrator guarantees:

- `settleSimple` is called once per simple round.
- `openComplex` is called once per complex round, before any `step`.
- `closeComplex` is called exactly once per `openComplex` (either by
  client `closeRound` request or by autoclose).
- `updateComplex` is called zero-to-many times between `openComplex`
  and `closeComplex`, fire-and-forget.

The wallet guarantees:

- A round opened with `openComplex` and not closed within a wallet-side
  grace window MUST be closeable by the orchestrator at any later time.
  If the wallet has its own deadline policy, it MUST emit
  `autocloseRequested` rather than silently expiring the round.
- **Autoclose backstop (hard requirement).** Because the orchestrator
  runs no idle timers (ADR-003), an open complex round only ever closes
  in response to an external signal. Every adapter MUST therefore
  guarantee that some signal eventually arrives for every open round  -
  it MUST satisfy at least one of:
    1. forward a wallet-native deadline/expiry as `autocloseRequested`;
    2. forward `sessionClosed` (the orchestrator cascades it to
       autoclose-then-drop the open round); or
    3. derive its own backstop deadline and emit `autocloseRequested`
       when no upstream signal exists.

  An adapter that can neither be told to close a round nor derive a
  close on its own is **non-conformant**  - it would leak open rounds
  forever. This is not optional: the conformance suite
  (`@open-rgs/adapter-test-kit`) asserts an open round reaches
  `closeComplex` after an autoclose signal, and operators relying on
  RGS-side scheduling must instead drive autoclose from their wallet or
  the admin endpoint.
- `BalanceChangedEvent` is emitted whenever the balance changes for any
  reason (round settle, deposit, withdrawal, manual adjustment).

### Open-round persistence & resume (v1.7  - adapters MAY omit until then)

Decided in **ADR-007**: cross-pod / post-restart resume is
wallet-driven  - `openSession` is the inquiry, `SessionInfo.openRound`
is the answer. No separate `getOpenRound` RPC.

While a complex round is open, the wallet MUST persist, keyed by
session:

- the `roundId` (from its own `openComplex` receipt);
- the `bet` (plus `betIndex` / `priceMultiplier` for its native audit
  trail  - already on `OpenComplex`);
- the mode the round was opened in;
- the **initial state** (`OpenComplex.initialState`) and the **last
  state checkpoint** (the most recent `UpdateComplex.state`; the
  initial state when no checkpoint has arrived);
- the open timestamp.

This record is cleared (or marked closed) by `closeComplex`, including
autoclose.

On `openSession`, when such a record exists, the adapter SHOULD return
it as `SessionInfo.openRound` so a fresh INIT on **any** pod can
re-hydrate the round (Spec 02 §Resume on reconnect). Ops never cross
to the wallet (see below), so a wallet-built `OpenRoundResume` MAY
carry empty `ops` / `actionLog`  - resume is then state-correct but
render-degraded; same-pod resume keeps full fidelity.

Until v1.7, adapters MAY omit all of this; the orchestrator treats an
absent `openRound` as "nothing to resume" and
`manifest.recovery.onRestart` applies. The autoclose backstop above is
**unchanged**  - resume rescues the player who returns; the backstop
settles the round of the player who never does.

### Reversal (optional)  - Guarantee 2, "One Round, One Record"

`reverseRound` is **optional** and **wallet-initiated**: it exists for
chargebacks, reconciliation reversals, and operator corrections. The RGS never
originates a reversal  - it's the wallet's tool for undoing a settlement it has
decided was wrong. Implement it only if your upstream supports reversal; omit
the method otherwise.

When implemented, it MUST honour Guarantee 2 (`specs/00-guarantees.md`):

- **Whole-record.** A round is the balance delta *and* the carry it produced.
  A reversal restores **both**  - the pre-round balance and the pre-round carry  -
  in one atomic step. Undoing the money while leaving the carry advanced (or
  vice-versa) is the rollback-farming exploit this guarantee forbids: a player
  keeps meta-counter progress for a round whose money was refunded.
- **Latest-first.** Only the most recent un-reversed round of a session may be
  reversed. Reversing an *older* round while newer rounds sit on top would
  restore a pre-state that predates them and silently over-refund  - so an
  adapter MUST reject that (`reversed: false`, `reason: "not-latest-round"`),
  never apply it. A wallet reversing a span reverses newest-to-oldest.
- **No-op, not error, when nothing to reverse.** An unknown or already-reversed
  round returns `{ reversed: false, reason }` and moves no money  - reversing
  twice must not credit twice. Idempotency-key dedupe applies as elsewhere.
- **Safe under concurrency.** Because reversal is wallet-initiated, it arrives
  *outside* the orchestrator's per-session lock  - that lock serializes only
  client-driven traffic, so nothing upstream of the adapter orders a reversal
  against an in-flight `settleSimple`/`openComplex`/`closeComplex` on the same
  session. An adapter MUST implement `reverseRound` to be safe under concurrent
  invocation with those calls (its own per-session mutex, an upstream
  transaction  - the mechanism is the adapter's choice).
- **Durable tracking.** A real adapter MUST persist its reversed-round
  tracking  - the reversal receipts it replays on a repeat, the set of
  already-reversed rounds, and the ordering basis behind latest-first  -
  durably, so it survives a process restart. An adapter that forgets prior
  reversals on restart turns a retried reversal into a second credit.

The reference `@open-rgs/platform-mock` implements these semantics correctly (a
per-session LIFO stack of `(roundId, balanceBefore, carryBefore)` snapshots,
plus a receipt map for idempotent replay). It keeps all of that **in memory**  -
by design, it is a dev mock  - so it is deliberately not a model for the
durable-tracking rule above. The conformance suite asserts the whole-record,
latest-first, and no-double-credit properties.

### Health

- `isHealthy` returns `true` when the wallet is currently capable of
  serving RPCs. Transient reconnect states MAY return true if the
  adapter has lazy reconnect.
- `diagnostics` returns operational counters and current state for the
  `/healthz` endpoint. No PII.

### Events

The provider MUST forward the following upstream signals as
`PlatformEvent`s:

```ts
type PlatformEvent =
  | { type: "balanceChanged"; sessionId; balance; reason }
  | { type: "sessionClosed"; sessionId; reason }
  | { type: "promoGranted"; sessionId; promo: PromoFreeRounds }
  | { type: "autocloseRequested"; sessionId; roundId?; reason }
```

Events not modelled by these variants are dropped. Future variants
require a contract bump (additive, non-breaking  - orchestrator tolerates
unknown types).

## Error translation

Adapters translate native errors into `RGSErrorCode` at the boundary.
Recommended mappings for common WebSocket-based codes:

| Native code | -> | Canonical |
|-------------|---|-----------|
| `InsufficientFunds` | -> | `INSUFFICIENT_BALANCE` |
| `SessionInvalid` | -> | `SESSION_INVALID` |
| `InvalidRoundOperation` | -> | `INVALID_ROUND` |
| `ProtocolViolation` | -> | `INTERNAL_ERROR` |
| (anything else) | -> | the verb-specific failure code (`SPIN_FAILED`, `OPEN_FAILED`, etc.) |

Adapters SHOULD include the native code in the error message text for
debuggability. Orchestrators SHOULD NOT log raw native codes outside
debug level (avoids leaking operator-specific vocabulary).

## Idempotency expectations

Every state-changing RPC carries an `idempotencyKey`, and **wallets MUST
dedupe on it**: a repeat of the same key is the same logical operation and
must move money at most once, returning the original receipt. This is the
contract's only defence against a lost-response retry double-debiting or
double-crediting.

Key derivation (see `@open-rgs/core`'s `idempotency.ts`):

- **Settling a known round**  - `closeComplex` from a client CLOSE, an
  `autocloseRequested` event, the `sessionClosed` cascade, or the admin
  endpoint  - derives the key deterministically from `(sessionId, roundId)`
  (`"<sessionId>:<roundId>:close"`). Every close path and every retry of a
  round therefore present the **identical** key, so a duplicated or raced
  close (e.g. a client close arriving alongside an autoclose) collapses to
  a single credit. No client cooperation is needed.

- **Round-initiating calls**  - a simple `settleSimple` (spin) or
  `openComplex` (open)  - have no server-assigned round id yet. Retry-safety
  there requires a stable token from the client (`ClientRequestSpin
  /OpenRound.idempotencyKey`): when present the key is derived from it
  (`"<sessionId>:spin:<token>"`), so the client can safely resend. When
  absent the orchestrator falls back to a random key  - a blind retry of a
  round-initiating call **without** a client token cannot be deduped, and
  clients SHOULD resume the round on reconnect rather than blind-retry.

Adapters MUST forward this key downstream when the underlying protocol
supports it; if not, the adapter is responsible for local dedupe. The
`IdempotencyConfig.ttlMs` (default 5 min) is the recommended dedupe window.

## Reference adapter behavior (illustrative)

A typical persistent-WebSocket adapter (such as the one in the external
`example-game-server`, not in this repo) implements:

- `connect()` opens a single shared WebSocket per server, performs the
  upstream's handshake, and awaits its acknowledgement.
- Lazy reconnect on an idle-timeout close; the next RPC after an idle
  disconnect transparently reconnects.
- An outbound sequence counter; correlation ids on inbound frames.
- `openSession` -> the upstream's session-info request; the response is
  mapped to canonical `SessionInfo` (an active promo free-rounds pool is
  translated).
- `settleSimple` -> the upstream's play-round request; `betIndex` and
  `priceMultiplier` are forwarded as-is to preserve the upstream's
  accounting.
- `openComplex` / `closeComplex` -> the upstream's open/close-round requests.
- `updateComplex` -> the upstream's state-update request, fire-and-forget.
- Inbound events are translated: balance-changed -> `balanceChanged`,
  session-closed -> `sessionClosed`, autoclose-requested (if the upstream
  emits one) -> `autocloseRequested`.

A real adapter is **private to the operator**  - it lives outside this repo
because it encodes a commercial API contract. Public packages never name a
specific provider's brand, product id, or wire shape.

## What the wallet does NOT see

- Math source. The wallet receives only `roundState` strings (math's
  serialised state) and a `type` tag. It cannot derive paytables from
  these.
- Player UI state. Ops never cross to the wallet.
- Cheat hints. Even when `cheat` is set on a request, the wallet sees
  only the resulting outcome's multiplier  - same as a normal spin.

## Acceptance criteria

- A `PlatformAdapter` implementation that throws synchronously from any
  method is treated by the orchestrator as a transient failure (the
  request fails with the appropriate `*_FAILED` code, but subsequent
  requests succeed when the wallet recovers).
- `BalanceChangedEvent` for an unknown session is silently dropped by
  the orchestrator (logged at debug only).
- `sessionClosed` with an open round triggers autoclose-then-drop
  (verifiable by the wallet recording a CloseRound before
  `LocalSession` is removed from cache).
- The mock wallet's `requestAutoclose(sessionId)` test helper, fired
  during a complex round, results in the expected wallet `closeComplex`
  call within one event-loop turn.

## Open questions

- ~~Should `PlatformAdapter` expose `getOpenRound(sessionId)` for
  cross-process resume?~~ **Decided  - no** (ADR-007): `openSession` is
  the inquiry; the wallet returns `SessionInfo.openRound` per
  §"Open-round persistence & resume" above.
- Should `PlatformAdapter` expose a `listOpenSessions()` for boot-time
  recovery? Same caveats. **Pending**.
- Idempotency key forwarding is currently not in the contract. Adding
  it is non-breaking (optional field). **Plan to add** when first
  retry-friendly transport ships.
