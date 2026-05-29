# Spec 04  - Wire Protocol (binary-msgpack reference)

## Goal

Define the canonical client-facing wire format. Alternative transports
(JSON-WS, REST, gRPC) MAY serialize the same logical messages differently,
but they share the request/response shapes spec'd in
`@open-rgs/contract`.

## Frame format

Each WebSocket message is one frame, binary, of the form:

```
[type_byte: u8][payload: msgpack]
```

The first byte is a message type code. The remainder is a MessagePack
encoding of the typed request or response.

**Correlation id.** The client stamps a unique id on each request payload
under the reserved key `$cid` (`WIRE_CORRELATION_KEY`); the transport echoes
it on the matching response / error frame. The client matches responses by
this id, not just by frame type  - so a late or duplicate response from a
timed-out request can't resolve a newer call. `PING`/`PONG` are unsolicited
and carry no id; a pre-dispatch error (unparseable frame) may omit it. The
client strips `$cid` before returning the response to callers.

## Message types

| Code | Direction | Logical message            | Payload type |
|------|-----------|----------------------------|--------------|
| `0x01` | C->S | INIT_REQUEST              | `ClientRequestInit` |
| `0x02` | S->C | INIT_RESPONSE             | `ClientResponseInit` |
| `0x03` | C->S | SPIN_REQUEST              | `ClientRequestSpin` |
| `0x04` | S->C | SPIN_RESPONSE             | `ClientResponseSpin` |
| `0x05` | C->S | OPEN_ROUND_REQUEST        | `ClientRequestOpenRound` |
| `0x06` | S->C | OPEN_ROUND_RESPONSE       | `ClientResponseOpenRound` |
| `0x07` | C->S | STEP_ROUND_REQUEST        | `ClientRequestStepRound` |
| `0x08` | S->C | STEP_ROUND_RESPONSE       | `ClientResponseStepRound` |
| `0x09` | C->S | CLOSE_ROUND_REQUEST       | `ClientRequestCloseRound` |
| `0x0a` | S->C | CLOSE_ROUND_RESPONSE      | `ClientResponseCloseRound` |
| `0x0b` | C->S | PROMO_ACCEPT_REQUEST      | `ClientRequestPromoAccept` |
| `0x0c` | S->C | PROMO_ACCEPT_RESPONSE     | `ClientResponsePromoAccept` |
| `0xfe` | C->S | PING                      | `{}` |
| `0xfd` | S->C | PONG                      | `{}` |
| `0xff` | S->C | ERROR                     | `ClientResponseError` |

Codes `0x10`-`0x7f` are reserved for future protocol extensions.
Codes `0x80`-`0xfc` are reserved for application/game-specific
extensions and MUST be ignored by the canonical orchestrator.

## URL convention

The reference transport listens on `ws://host:PORT/wss` and
`ws://host:PORT/api/wss`. Multi-game deployments use
`ws://host:PORT/api/{gameId}/wss` (planned; see **Spec 02 §Open
questions**).

A `sessionId` query parameter is accepted at upgrade time but the
authoritative session-bind happens via INIT_REQUEST `sid`.

## Message schemas

The full TS schemas live in `@open-rgs/contract`:

- `ClientRequestInit`, `ClientResponseInit`
- `ClientRequestSpin`, `ClientResponseSpin`
- `ClientRequestOpenRound`, `ClientResponseOpenRound`
- `ClientRequestStepRound`, `ClientResponseStepRound`
- `ClientRequestCloseRound`, `ClientResponseCloseRound`
- `ClientRequestFrcAccept`, `ClientResponseFrcAccept`
- `ClientResponseError`

This spec doesn't duplicate them  - read the source. What this spec
DOES specify:

- **Field semantics** for the cases that aren't obvious from the type.
- **Error code vocabulary** (canonical set in `RGSErrorCode`).
- **Backward-compat policy**.

### Notable field semantics

`ClientResponseInit.modes`  - every entry in this catalog is renderable
by the client. Internal modes (`internal: true` in the manifest) are
excluded server-side. The catalog is the authoritative source for
"which buy buttons should I show" and their stake multipliers.

`ClientResponseInit.resume`  - present iff a round was in flight when
the player previously disconnected. The client SHOULD replay
`resume.ops` in order to rebuild visual state, then render UI for
`resume.awaiting`. The action history `resume.actionLog` is provided so
the client can narrate "you've already gambled twice."

`ClientRequestSpin.priceMultiplier`  - defaults to 1 if absent. Combined
with the manifest's mode `stakeMultiplier` to compute the actual bet.

Forced-outcome cheats are **not** a wire field  - `ClientRequestSpin` has no
`cheat`. A forced-outcome field must never be part of the canonical
contract. In dev only, a cheat hint may ride inside
`ClientRequestSpin.params.cheat`, and the orchestrator honors it **only**
when cheats are explicitly enabled (`createServer { enableCheats }` /
`OPEN_RGS_ENABLE_CHEATS=1`) AND `NODE_ENV !== "production"`. It is off by
default everywhere and impossible in production  - a misconfigured
`NODE_ENV` can no longer enable it.

`ClientResponseSpin.promo`  - present iff the promo pool was active for
this spin. Tells the client the remaining count so it can update the
HUD ("8 / 10 free spins left").

`ClientRequestStepRound.action`  - MUST have a `type` field. The
orchestrator validates `action.type` against the stored `awaiting.type`
before invoking math; mismatches return `INVALID_ACTION` at the
transport boundary.

## Error vocabulary (`RGSErrorCode`)

```
INVALID_FORMAT           binary frame couldn't be parsed
DECODE_ERROR             msgpack payload couldn't be decoded
MISSING_SESSION          sid required, not provided
SESSION_NOT_FOUND        sid valid but no session in cache (INIT first)
SESSION_INVALID          wallet rejected the session
INSUFFICIENT_BALANCE     pre-flight or wallet rejection on funds
INVALID_BET              betIndex out of range, or invalid combination
INVALID_MODE             requested mode not in manifest, or wrong kind
INVALID_ACTION           step action.type didn't match awaiting.type
INVALID_ROUND            close called before terminal, or round-id mismatch
PLATFORM_UNAVAILABLE    wallet not connected
MATH_TIMEOUT             math exceeded its per-call execution budget
ROUND_ALREADY_OPEN       openRound while another is in flight
NO_ROUND_OPEN            step/close without an active round
INTERNAL_ERROR           uncaught exception (should never escape)
INIT_FAILED              wallet error during openSession
SPIN_FAILED              wallet error during settleSimple
OPEN_FAILED              wallet error during openComplex
STEP_FAILED              math threw during step (validation passed)
CLOSE_FAILED             wallet error during closeComplex
```

Adding a code is non-breaking. Removing one is breaking. Renaming one
is breaking. Wallet adapters MUST translate native errors into this
vocabulary (see **Spec 05**).

## Frame size budget

Typical frame sizes for budgeting:

- INIT_REQUEST: ~80 bytes (just `{sid: "uuid"}`).
- INIT_RESPONSE: ~400-800 bytes (mode catalog + bet ladder + maybe
  resume payload).
- SPIN_REQUEST: ~40 bytes.
- SPIN_RESPONSE: ~200-2000 bytes (depending on ops density). Most slots
  emit 5-20 ops per spin.
- STEP_REQUEST: ~30-60 bytes.
- STEP_RESPONSE: ~100-500 bytes.

Hard cap: a single frame MUST NOT exceed 1 MiB. Larger payloads
indicate a math bug (runaway `ops` array) and the transport SHOULD
disconnect the client. Enforced (`MAX_FRAME_BYTES`): inbound via Bun's
`maxPayloadLength` (oversized frames close the connection before reaching
the handler); outbound, `sendFrame` refuses to emit a larger frame and
sends a bounded `INTERNAL_ERROR` instead.

## PING / PONG

Optional keepalive. Either side MAY send PING; recipient MUST reply
PONG within 5 seconds. Client uses this to detect half-open
connections; the orchestrator does NOT use it for autoclose decisions
(autoclose is external  - see **Spec 02**).

## Versioning

The protocol carries no explicit version field in frames. Version
discovery happens out of band (HTTP `/api/manifest`, which exposes
`schema: 1`). A breaking change increments the schema; old clients
get `INVALID_FORMAT` on unknown message codes.

## Acceptance criteria

- A frame with type byte `0x03` and a valid `ClientRequestSpin` payload
  produces a `0x04` response or `0xff` error within the latency budget
  in **Spec 06**.
- A frame with type byte in `0x80`-`0xfc` is silently ignored by the
  canonical orchestrator (no response, no error log above debug level).
- A text frame (string, not binary) is rejected with
  `0xff INVALID_FORMAT` immediately, without further processing.
- A frame larger than 1 MiB is rejected at the transport layer.

## Open questions

- Should we add `0x0d / 0x0e` for `AUTOCLOSE_NOTIFY` so clients see
  autoclose-triggered closes distinguished from player-initiated
  closes? Currently autoclose produces a normal `CLOSE_RESPONSE` with
  `type` reflecting the math's autoclose tag. **Probably sufficient**;
  decision pending.
- JSON-WS transport for browser dev tooling  - should it use the same
  type byte scheme (just JSON-encoded payloads) or speak a JSON-RPC
  variant? **Pending**; first implementation will pick.
