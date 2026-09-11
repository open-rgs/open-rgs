---
"@open-rgs/adapter-artube": minor
---

`withDemoSessions` — serve Artube demo sessions from memory.

Artube's demo mode has no requests of its own: `PlayRound`, `OpenRound`,
`UpdateRoundState` and `CloseRound` look identical either way, a demo round is
not persisted, and a session is a demo session when its **currency is null**.
From there the backend is expected to track the virtual balance itself, for as
long as the session lives.

The decorator does that, for everything the Games API would be storing and not
just the balance: the round state at open, each update, the final state at
close, the carry, and the finished round the way `last_round` holds it. A demo
session is answered from memory and never reaches the wire; a real one passes
straight through untouched. `demoSessionFor(sessionId)` returns the store, since
play money has no back office to inspect. The bet ladder
still comes from the wallet — it is not money, and a demo player should be able
to bet what a real one can.

It persists nothing (matching the platform: a demo round is not stored, so a
reconnect may not restore one) and it never infers demo-ness from anything but
the wallet's own answer — a session-id prefix or a config flag getting that
backwards is how play money reaches a real balance.
