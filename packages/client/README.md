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
| `connect()` | `Promise<void>` — opens the WS, waits for `onopen` |
| `disconnect()` | `void` — closes the WS gracefully |
| `init(sid)` | `Promise<ClientResponseInit>` |
| `spin({ mode?, betIndex?, priceMultiplier?, cheat?, params? })` | `Promise<ClientResponseSpin>` |
| `openRound({ mode?, betIndex?, priceMultiplier?, params? })` | `Promise<ClientResponseOpenRound>` |
| `stepRound({ action })` | `Promise<ClientResponseStepRound>` |
| `closeRound({})` | `Promise<ClientResponseCloseRound>` |
| `frcAccept({ accept })` | `Promise<ClientResponseFrcAccept>` |

All types come from `@open-rgs/contract`.

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
`RgsClient` instances if you genuinely need parallelism — but normal
slot UX is one-spin-at-a-time.
