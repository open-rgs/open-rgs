# Spec 05 — Wallet Protocol

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

`SessionInfo.currencyDecimals` is **required** — every adapter MUST
populate it from the upstream platform (config, DB, openSession
response, wherever the provider exposes it). EUR/USD/RUB = 2,
JPY/HUF = 0, BTC = 8.

The contract requires every `balance`, `bet`, `win`, and amount on
this interface to be an **integer in the currency's minimal unit**
(USD 1.00 → 100 when `currencyDecimals = 2`). The orchestrator never
converts amounts — math operates on integers throughout. Adapters
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
- `BalanceChangedEvent` is emitted whenever the balance changes for any
  reason (round settle, deposit, withdrawal, manual adjustment).

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
require a contract bump (additive, non-breaking — orchestrator tolerates
unknown types).

## Error translation

Adapters translate native errors into `RGSErrorCode` at the boundary.
Recommended mappings for common WebSocket-based codes:

| Native code | → | Canonical |
|-------------|---|-----------|
| `InsufficientFunds` | → | `INSUFFICIENT_BALANCE` |
| `SessionInvalid` | → | `SESSION_INVALID` |
| `InvalidRoundOperation` | → | `INVALID_ROUND` |
| `ProtocolViolation` | → | `INTERNAL_ERROR` |
| (anything else) | → | the verb-specific failure code (`SPIN_FAILED`, `OPEN_FAILED`, etc.) |

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

- **Settling a known round** — `closeComplex` from a client CLOSE, an
  `autocloseRequested` event, the `sessionClosed` cascade, or the admin
  endpoint — derives the key deterministically from `(sessionId, roundId)`
  (`"<sessionId>:<roundId>:close"`). Every close path and every retry of a
  round therefore present the **identical** key, so a duplicated or raced
  close (e.g. a client close arriving alongside an autoclose) collapses to
  a single credit. No client cooperation is needed.

- **Round-initiating calls** — a simple `settleSimple` (spin) or
  `openComplex` (open) — have no server-assigned round id yet. Retry-safety
  there requires a stable token from the client (`ClientRequestSpin
  /OpenRound.idempotencyKey`): when present the key is derived from it
  (`"<sessionId>:spin:<token>"`), so the client can safely resend. When
  absent the orchestrator falls back to a random key — a blind retry of a
  round-initiating call **without** a client token cannot be deduped, and
  clients SHOULD resume the round on reconnect rather than blind-retry.

Adapters MUST forward this key downstream when the underlying protocol
supports it; if not, the adapter is responsible for local dedupe. The
`IdempotencyConfig.ttlMs` (default 5 min) is the recommended dedupe window.

## Reference adapter behavior (your platform)

The your platform reference adapter (lives in `example-game-server`,
not in this repo) implements:

- `connect()` opens a single shared WebSocket per server, sends a
  `Hello` envelope, awaits `Welcome`.
- Lazy reconnect on `GoAway: IdleTimeout`. The next RPC after an idle
  disconnect transparently reconnects.
- `op_seq` counter on outbound envelopes; correlation IDs on inbound.
- `openSession` → `SessionInfoRequest`. Returned `SessionInfoResponse`
  is mapped to canonical `SessionInfo`. Active promo free-rounds pool is translated.
- `settleSimple` → `PlayRoundRequest`. `betIndex` and `priceMultiplier`
  are forwarded as-is to preserve your platform's accounting.
- `openComplex` / `closeComplex` map to `OpenRoundRequest` /
  `CloseRoundRequest`. Not yet implemented (lucky-digits is simple-only).
- `updateComplex` maps to `UpdateRoundStateRequest`, fire-and-forget.
- Inbound events on the `events` channel are translated:
  `BalanceChangedEvent` → `balanceChanged`, `SessionClosedEvent` →
  `sessionClosed`. `AutocloseRequestedEvent` (if your platform emits one) →
  `autocloseRequested`.

The adapter is **private to the operator** — it lives outside this repo
because it encodes a commercial API contract.

## What the wallet does NOT see

- Math source. The wallet receives only `roundState` strings (math's
  serialised state) and a `type` tag. It cannot derive paytables from
  these.
- Player UI state. Ops never cross to the wallet.
- Cheat hints. Even when `cheat` is set on a request, the wallet sees
  only the resulting outcome's multiplier — same as a normal spin.

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

- Should `PlatformAdapter` expose `getOpenRound(sessionId)` for
  cross-process resume? Optional method, only providers that support it
  populate it; orchestrator falls back to recovery policy otherwise.
  **Pending decision** based on which wallets we integrate next.
- Should `PlatformAdapter` expose a `listOpenSessions()` for boot-time
  recovery? Same caveats. **Pending**.
- Idempotency key forwarding is currently not in the contract. Adding
  it is non-breaking (optional field). **Plan to add** when first
  retry-friendly transport ships.
