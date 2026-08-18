# @open-rgs/client

Tiny WebSocket client for open-rgs. Promise-based RPC, msgpack
framing, zero opinions. Bun / Node / browser.

## Use

```ts
import { RgsClient } from "@open-rgs/client";

const c = new RgsClient("ws://localhost:8080/wss");
await c.connect();

const init = await c.init("session-1");
console.log(init.balance, init.allowedBets);

const spin = await c.spin({ betIndex: 2 });
console.log(spin.ops, spin.balance, spin.win, spin.multiplier);

c.disconnect();
```

## API

| Method | Returns |
|---|---|
| `connect()` | `Promise<void>`, opens the WS, waits for `onopen` |
| `disconnect()` | `void`, closes the WS gracefully |
| `init(sid)` | `Promise<ClientResponseInit>` |
| `spin({ mode?, betIndex?, priceMultiplier?, params?, idempotencyKey? })` | `Promise<ClientResponseSpin>` |
| `openRound({ mode?, betIndex?, priceMultiplier?, params?, idempotencyKey? })` | `Promise<ClientResponseOpenRound>` |
| `stepRound({ action })` | `Promise<ClientResponseStepRound>` |
| `closeRound({})` | `Promise<ClientResponseCloseRound>` |
| `promoAccept({ accept })` | `Promise<ClientResponsePromoAccept>` |

All types come from `@open-rgs/contract`.

`stepRound` and `closeRound` also accept `idempotencyKey`, so every
money-moving call can be resent safely.

## UniversalClient

`RgsClient` speaks the wire. `UniversalClient` is the layer above it that
every integration otherwise rewrites: play a round to completion whatever
shape it is, retry safely, and print what happened.

```ts
import { RgsClient, UniversalClient, describeRound } from "@open-rgs/client";

const rgs = new RgsClient("ws://localhost:8080/wss");
await rgs.connect();

const uc = new UniversalClient(rgs);
const init = await uc.init("session-1");

await uc.resumeIfUnfinished(init);

const round = await uc.playRound(0);
console.log(describeRound(round));
```

It tries a simple spin first; a complex mode answers `INVALID_MODE` and it
switches to open/step/close, so it never needs telling which kind of game it
is talking to. Every call carries an idempotency token that a retry reuses, so
a retry is deduplicated server-side rather than replayed as a second round.

| Option | Default | What it does |
|---|---|---|
| `decide(awaiting, steps)` | picks the first offered option | answers whatever a round waits for |
| `maxSteps` | 200 | guard against math that never reaches a terminal state |
| `keyFor(call, n)` | a counter | mint the idempotency token per logical call |
| `retries` | 2 | attempts on a transport or platform failure |

`describeRound()` renders a stable, greppable line per event, for a test
fixture, a CI log, or a bug report. Games emitting the canonical ops from
`@open-rgs/contract/ops` get their ops rendered; games emitting their own
shapes still run, still settle, and still produce a transcript.

This is not a game client and has no opinion about presentation. It is for
smoke-testing a build, driving an integration against a wallet sandbox,
capturing a transcript to diff after a change, and proving a deferred-close
round survives a disconnect.

## open-rgs-play

The same thing as a command, for a server you just deployed. No game code, no
fixtures, no knowledge of which modes are simple and which are complex.

```bash
bunx open-rgs-play ws://localhost:8080/wss
bunx open-rgs-play ws://localhost:8080/wss --rounds 20 --mode bonus
bunx open-rgs-play ws://localhost:8080/wss --rounds 5 --retry-token
```

| Flag | What it does |
|---|---|
| `--sid ID` | session id (default: a fresh one per run) |
| `--rounds N` | how many rounds to play (default 1) |
| `--bet N` | bet index (default 0) |
| `--mode NAME` | game mode |
| `--retry-token` | send every round with the SAME token |
| `--abandon` | open a round and disconnect without closing it |
| `--resume` | finish a round a previous session left open |
| `--json` | machine-readable output |
| `--quiet` | suppress the running commentary |

`--retry-token` is the fastest way to see whether retries are being
deduplicated: the balance must move exactly once however many rounds you ask
for, and the command exits non-zero if it does not.

`--abandon` and `--resume` exercise the replay path end to end - the first
walks away mid-round like a player closing the tab, the second comes back:

```bash
bunx open-rgs-play ws://localhost:8080/wss --sid s1 --mode deferred --abandon
bunx open-rgs-play ws://localhost:8080/wss --sid s1 --resume
```

A single round prints its full transcript; a run of them prints one line each
and a summary. Exit code is 1 on any failure, so it drops straight into CI.

## Errors

Server-side `RGSError`s come back as `RgsServerError(code, message)`:

```ts
import { RgsServerError } from "@open-rgs/client";

try {
  await c.spin({ betIndex: 99 });
} catch (e) {
  if (e instanceof RgsServerError) {
    console.log(e.code);     // "INVALID_BET"
    console.log(e.message);  // human-readable
  } else throw e;
}
```

Timeouts, disconnects, and concurrent-request rejection come back as
plain `Error`s.

## Constraint: one request at a time per connection

The wire protocol pairs requests to responses by frame-type, not by a
correlation id. If you call `spin()` while another `spin()` is in
flight, the second call rejects synchronously. Use multiple
`RgsClient` instances if you genuinely need parallelism, but normal
slot UX is one-spin-at-a-time.
