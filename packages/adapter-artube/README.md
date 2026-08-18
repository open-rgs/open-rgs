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
- **Events.** `BalanceChanged` and `SessionClosed` are surfaced as
  `PlatformEvent`s.

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

Two, both properties of the Artube Games API rather than gaps in this code.
They are listed because finding them at integration time is far worse than
reading them now.

**Complex rounds are not supported.** The API is one-shot, so `openComplex`,
`updateComplex` and `closeComplex` throw rather than silently no-oping. This
adapter serves simple-round games only.

**`idempotencyKey` is dropped.** `PlayRoundRequest` has no idempotency field,
so the key open-rgs generates never reaches the wallet. A retried settle after
a timeout or a reconnect is **not deduplicated wallet-side**. If the socket
drops between send and reply, the RGS cannot tell a lost request from a lost
response, and a retry can move money twice. Mitigate operationally -
reconciliation against the wallet's own round records - until the protocol
grows a field for it. This is the adapter's most significant gap.

## Conformance results

`test/conformance.test.ts` runs `@open-rgs/adapter-test-kit` against a fake
Artube server speaking the real wire protocol. Everything passes except two
checks that the wire cannot express, and those are allowlisted with their
reason rather than faked green:

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
