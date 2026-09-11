# @open-rgs/adapter-artube

A `PlatformAdapter` for open-rgs that talks to an Artube wallet over
WebSocket.

```bash
bun add @open-rgs/adapter-artube
```

```ts
import { createServer, binaryTransport, loadTsMath, cryptoRng } from "@open-rgs/core";
import { ArtubeAdapter } from "@open-rgs/adapter-artube";

await createServer({
  manifest,
  platform: new ArtubeAdapter({
    wsUrl:     process.env.GAMES_API_URL!,
    gameId:    "my-game",
    authToken: process.env.GAMES_API_KEY,
  }),
  transport: binaryTransport({ port: 8080 }),
});
```

## What it does

- **Handshake.** Sends `Hello` on open and refuses every RPC until `Welcome`
  arrives, so a half-open socket cannot serve a round.
- **Reconnect.** Exponential backoff with a cap, and it honours the
  `retry_after_ms` on a `GoAway` rather than reconnecting straight into a
  server that asked for room.
- **Heartbeat.** Terminates a zombie socket that stops answering, instead of
  waiting for a TCP timeout that may never come.
- **RPC deadlines.** Every request has one, so a wallet that goes quiet fails
  the round rather than hanging it.
- **Simple rounds.** `settleSimple` is one `PlayRoundRequest`.
- **Complex rounds.** `openComplex` / `updateComplex` / `closeComplex` are
  `OpenRoundRequest` / `UpdateRoundStateRequest` / `CloseRoundRequest`.
- **Autoclose.** An `AutocloseRequestEvent` from the platform surfaces as
  `PlatformEvent{type:"autocloseRequested"}`, and the close it provokes goes
  back out as `AutocloseRoundRequest`.
- **Events.** `BalanceChanged` and `SessionClosed` are surfaced as
  `PlatformEvent`s, with or without the `Event` suffix the docs use in
  places.

## Complex rounds

`OpenRound` debits the stake and names the round; `UpdateRoundState` leaves
the player's action log on the wallet; `CloseRound` credits the win. Three
things in that flow are this wire's own and worth knowing before you meet
them at integration time.

**`round_version` is the platform's counter, not yours.** Open returns it,
every update returns the next one, and each request must echo the newest one
the wallet handed back. Send a stale number and the round is refused with
`InvalidRoundOperation`. open-rgs has no concept of it, so the adapter tracks
it per round. Two consequences: a close for a round this adapter never opened
is refused locally rather than sent with a guessed version, and a close that
fails leaves the round's bookkeeping in place so a retry (or an autoclose) can
still use it.

**One `round_state` slot, two pieces of state.** A close carries the round's
final state *and* the carry the next round starts from; the wallet stores one
opaque string. The adapter packs both:

```json
{ "$rgs": 1, "state": { "step": 9 }, "carry": { "meterPoints": 42 } }
```

`openSession` unpacks `carry` out of it again. A string that was never packed
(a simple round's state, or anything written before this existed) is returned
verbatim, so no meter resets on the first read after an upgrade. Because the
wallet only persists the state of a round that moved money, this envelope is
also the only cross-round storage a game gets here - there is no player-level
bucket to put a meter in.

**Features come from the math's own state.** `CloseComplex` has no features
field, and putting an Artube concept in the neutral contract would be the
wrong fix. Instead the math names them in its state under a reserved key:

```ts
{ "$features": ["PlayedGamble"], "step": 4 }
```

The adapter reads `$features` from the open, each update and the close, and
sends the union on close - which is what the platform's merge rule asks for.
`"$status": "cancelled"` in the final state closes the round as cancelled;
anything else, a zero-win round included, is `completed`.

## Amounts are converted, on purpose

Artube states money in major units (`"balance": 150.75`). open-rgs counts
integer minor units and refuses a fractional bet outright, so an unconverted
`allowed_bets: [0.10, 0.25]` fails every round with `INVALID_BET`.

Everything inbound - balance, the bet ladder, promo bet, `BalanceChanged` - is
multiplied by the scale in `game_settings.currency_minimal_unit`, or by
`10^currencyDecimals` when the wallet does not send one. Nothing outbound needs
converting: this wire is amount-blind. `amountScaling: "verbatim"` turns it off
for a wallet already configured in minor units.

## Amount-blindness is deliberate

`PlayRoundRequest` carries `bet_index` and `price_multiplier`, never a money
amount. The wallet computes the stake from its own ladder and is the only party
that ever holds the number.

That is a protection, not a gap. It is the same rule open-rgs already applies to
math - math is currency-blind and returns a multiplier, never an amount - pushed
one layer further out, to the wire. An RGS that cannot state a monetary value
cannot mis-state one, so a bug in the game, the manifest or this adapter can
move the wrong *index*, but never invent the wrong *amount*.

The practical consequences:

- The best math knows only an index. If yours multiplies something by a bet
  value, that value came from somewhere it should not have.
- The adapter cannot over-declare a bet, which is why the conformance suite's
  overspend probe cannot trip it.
- The wallet's ladder is authoritative. Read it from `openSession` rather than
  assuming a length or a set of values; it is whatever that wallet says it is
  on that session, and nothing here hardcodes it.

## Known limitations

**`idempotencyKey` is dropped.** `PlayRoundRequest` has no idempotency field,
so the key open-rgs generates never reaches the wallet. A retried settle after
a timeout or a reconnect is **not deduplicated wallet-side**. If the socket
drops between send and reply, the RGS cannot tell a lost request from a lost
response, and a retry can move money twice. Mitigate operationally -
reconciliation against the wallet's own round records - until the protocol
grows a field for it. This is the adapter's most significant gap.

## Conformance results

`test/conformance.test.ts` runs `@open-rgs/adapter-test-kit` against a fake
Artube server speaking the real wire protocol (`test/fake-artube.ts`, which
refuses unknown sessions, stale `round_version`s and closed rounds the way the
platform does). `test/complex.test.ts` asserts the frames themselves: which
message type went out, which version rode on it, what landed in the state
slot. Everything passes except two checks that the wire cannot express, and
those are allowlisted with their reason rather than faked green:

| Check | Why it cannot pass |
|-------|--------------------|
| `idempotency.duplicate-key` | No idempotency field on the wire (see above). |
| `errors.insufficient-funds` | The probe drives `bet`, and this wire carries no amount by design. A test-kit fix that drives `priceMultiplier` instead is pending. |

A second test asserts those two are *still* failing, so if the wire or the test
kit changes, the allowlist goes red instead of quietly over-permitting.

## Configuration

| Option | Meaning |
|--------|---------|
| `wsUrl` | Wallet endpoint. Used verbatim; the operator's URL already carries the game id. |
| `gameId` | Sent as the `X-Game-ID` header. |
| `authToken` | Sent as the `X-Api-Key` header. Required in production. |
| `rpcTimeoutMs` | Per-request deadline. Default 30000. |
| `currencyDecimals` | Fallback precision when the wallet sends no `currency_minimal_unit`. Default 2. |
| `amountScaling` | `"minor-units"` (default) converts inbound amounts; `"verbatim"` passes them through. |
| `defaultRoundStateVersion` | `round_state_version` when the RGS has no math version to stamp. Default `"1"`. |
| `schemaVersion` | Hello schema, 1 (default) or 2. Schema 2 declares all 16 contract types; a type left undeclared is never delivered on that connection. |
| `handshakeTimeoutMs` | Hello to Welcome. Default 10000. |
| `heartbeatIntervalMs` | Ping cadence. |
| `heartbeatTimeoutMs` | How long a silent socket lives before it is terminated. |
| `reconnectBaseMs` | Backoff base. |
| `maxReconnectAttempts` | Give up after this many. |

No endpoint, key or operator identifier is baked into the source. Everything
comes from configuration.

## Conformance

The adapter is exercised by `@open-rgs/adapter-test-kit`, the same suite any
adapter should pass before it moves money. See `test/conformance.test.ts`.
