---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

**REST transport.** `restTransport()` runs the same orchestrator over plain
HTTP and JSON: one POST route per call, plus `GET /healthz`. `binaryTransport`
stays the default - a slot is a long-lived session with many small messages -
but REST suits a back-office tool, a smoke test, a curl in a runbook, or a
client behind something that will not proxy WebSockets.

It cannot push, and says so rather than pretending. `closeConnection` is
deliberately not implemented, so `concurrencyPolicy: "kick-old"` degrades to
`"allow"` and `createServer` warns at boot instead of silently doing nothing.
Each response carries the current balance. There is also no connection to bind
a session to, so the `sid` in the body is the only credential - the same token
the launch URL carries, but leaned on harder than over WebSocket.

**Deferred close.** `withDeferredClose(simpleMath)` lets a client finish a
round explicitly. The outcome is still decided in one call, but the round stays
open until the client ends it, so a player who closes the tab mid-presentation
reconnects, replays the spin, and closes it.

This converts the game into a complex round, and the docs say so plainly rather
than implying a third round shape: `open` runs the simple math and parks the
outcome, `close` pays it, and the money moves twice like any other complex
round. An open round therefore holds an outstanding debit - `autoclose` matters
more with this on - and `spin` is refused while one is open.

A late close pays exactly what the open decided, and `autoclose` settles at the
same value, so a player who never returned is not penalised and one who
returned late is not rewarded.

**Replay hint.** `OpenRoundResume.replay` is set when a round is open only
because the client never finished it, carrying `unfinished: true` and the
canonical message `"Unfinished round — watching replay"`. A client shows the
right thing without knowing which modes defer their close.
