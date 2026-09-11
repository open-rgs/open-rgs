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

**A round is not chained to whatever came before it.** `previous_round_id`
links a round to the one it continues - a bonus to the base round that
triggered it - and the platform validates the link: an id that is not this
session's actual previous round is refused with `InvalidRoundOperation`
("Invalid rounds sequence") and the open fails. The adapter does not send it.
Guessing from the last round it happened to close is a different claim and is
wrong the moment a simple settle, another pod or a restart comes between; and
the contract has no field for a deliberate chain to forward. When it grows
one, it belongs in `OpenComplex` rather than inferred here.

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

An in-flight round is written the same way, marked `"open": true`:

```json
{ "$rgs": 1, "open": true, "state": { "phase": "decide", "pending": 2 } }
```

`openSession` reads the carry back out of a final envelope, and out of an
unmarked string (anything written before this existed). A round marked open
yields **no carry at all** — unknown, not empty: its state is the math's
in-flight state, and handing that back is how a pod restart mid-round silently
resets a player's meters.

Which round is which comes from `last_round.finished_at` - `null` while the
round is open, set once it closes - with the marker as a second opinion. A
round is treated as open if either says so.

(An earlier build here refused to trust `finished_at`, on the strength of one
session that was already wedged: its `last_round` WAS an open round, so the
null was the field working correctly, read as evidence that it did not. The
marker stays because it costs nothing and does not depend on an optional field
staying present - not because the wire is untrustworthy.) A string that was never packed
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

## A round the wallet has open and you do not

A round is opened - and debited - by one process. That process dies, or the
pod rolls, or the player returns on another instance. The RGS has no memory of
the round, the wallet still does, and every subsequent round on that session is
refused with `InvalidRoundOperation: Round is already opened`. The player is
stuck until someone closes it by hand.

Artube's `SessionInfo` answers the question the open-rgs contract cannot ask
yet (ADR-007): `last_round` with no `finished_at` IS the open round, carrying
its state, its `round_version` and the price it was opened at. On every
`openSession` the adapter surfaces it:

```ts
const orphan = adapter.openRoundFor(sessionId);
// { roundId, state, betIndex, priceMultiplier, mathVersion?, startedAt? }
```

and adopts the round, so a `closeComplex` for it works - the version is the
wallet's own, not a guess.

What to settle it at is deliberately NOT the adapter's decision. The game owns
the math that can value the state (`ComplexMath.autoclose` takes exactly this
string), and only the game knows whether its policy is to pay what was on the
table or to forfeit it. Close it with a `reason`, which makes it an
`AutocloseRoundRequest` - it was not the player who asked.

## Demo sessions

Artube's demo mode has no requests of its own — `PlayRound`, `OpenRound`,
`UpdateRoundState` and `CloseRound` look identical either way. A session is a
demo session when its **currency is null**; that is the whole marker, and from
there the backend tracks the virtual balance itself.

```ts
const platform = withDemoSessions(new ArtubeAdapter({ ... }), {
  startingBalance: 1_000_000,
});
```

A demo session is then answered from memory and never reaches the wire; a real
one passes straight through. The bet ladder still comes from the wallet — it is
not money, and a demo player should be able to bet what a real one can — and so
does the answer to "is this demo at all".

**Everything the Games API would store is stored, not just the balance**: the
round state at open, every update to it, the final state at close, the carry
that threads to the next round, and the finished round the way `last_round`
would hold it. A demo round that kept only the money would behave differently
from a real one in the one place a game actually reads.
`demoSessionFor(sessionId)` returns that store, because when a demo round
behaves oddly there is no back office to go and look in.

Two things it does not do, both deliberate. It **persists nothing**: a demo
balance and its carry live as long as the process, which is the platform's own
behaviour (a demo round is not stored, so a reconnect may not restore one), and
inventing durability for play money would be worse than not having it. And it
**never guesses**: a session is demo because the wallet returned no currency
for it, not because of a session-id prefix or a config flag. Getting that
backwards is how play money reaches a real balance.

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

## Idempotency, without an idempotency field

`PlayRoundRequest` and `CloseRoundRequest` have no idempotency field, so the
key open-rgs generates cannot reach the wallet and the wallet cannot dedupe.
Three things close most of that gap; read what each one does and does not
cover before relying on it.

**The same key is settled once per process.** The key is claimed *before* the
request goes out and what is remembered is the in-flight promise, so two
concurrent settles with one key produce one payment rather than a race. (The
earlier version remembered the finished receipt, which was a read-then-write
race — both missed, both paid. `@open-rgs/adapter-test-kit`'s concurrency
certification found it the first time it was switched on.) Keys are scoped per
session: a client-supplied key from one player can never suppress another's
settle. A settle that *fails* releases its key, so a genuine retry is not
refused by the memory of an attempt that moved no money.

**An unanswered settle is checked, not retried blind.** The key rides inside
the round state the adapter writes:

```json
{ "$rgs": 1, "key": "…", "state": { … }, "carry": { … } }
```

so when a settle times out or the socket drops, the adapter reads the session's
last round back and looks for that key. Found: the settle landed, and its
receipt is returned instead of a failure that would provoke a retry. Not found:
the failure stands, which is the safe direction. This is what turns "lost
request or lost response?" — the question that makes a blind retry dangerous —
into one the adapter can answer.

**What is still not covered.** A retry that lands on a *different pod* meets a
cold dedupe cache; the reconciliation path is what catches it, and it needs the
wallet reachable. If the wallet is unreachable *and* the answer was lost, the
settle is genuinely unresolved and is logged as
`event.action: settle_unreconciled` for reconciliation against the wallet's own
records. A field on the wire would still be better than all of this.

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
| `errors.insufficient-funds` | The probe drives `bet`, and this wire carries no amount by design. A test-kit fix that drives `priceMultiplier` instead is pending. |

`idempotency.duplicate-key` used to be on that list and passes now — see above.
The concurrency certification is switched on (it is opt-in, and was not), which
is how the dedupe race was found. `concurrency.reverse-interleave` is skipped
rather than failed: this wire has no game-initiated rollback message, so
`reverseRound` has nothing to call.

A second test asserts those two are *still* failing, so if the wire or the test
kit changes, the allowlist goes red instead of quietly over-permitting.

## What the wallet says for the client

`SessionInfo.clientData` carries the per-session things a game's UI needs and
the RGS has no business reading: the `gamification_token` their docs say to
forward unchanged, the platform max win to print in the rules, the allowed
auto-spin counts, the RTP to display, the win history, the security hash. They
reach the client verbatim in the INIT response. Before this they were parsed
off the wire and dropped, which meant a real game's UI could not be built on
this adapter at all.

`is_platform_max_win_reached` is the one that is *not* cosmetic: it is the
wallet capping a round on its own side, which the RGS cannot infer — the
balance is simply smaller than the multiplier implies. It comes back on the
receipt as `platformMaxWinReached` and reaches the client as `platformMaxWin`
on the spin and close responses.

## Configuration

| Option | Meaning |
|--------|---------|
| `wsUrl` | Wallet endpoint. Used verbatim; the operator's URL already carries the game id. |
| `gameId` | Sent as the `X-Game-ID` header. |
| `authToken` | Sent as the `X-Api-Key` header. Required in production. |
| `rpcTimeoutMs` | Per-request deadline. Default 30000. |
| `reconcileTimeoutMs` | How long to wait for the socket before asking whether an unanswered settle landed. Default 10000. |
| `settleCacheSize` | Settled keys remembered per process. Default 10000. |
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
