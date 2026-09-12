---
"@open-rgs/contract": minor
"@open-rgs/core": minor
"@open-rgs/adapter-artube": minor
---

Resume a round the wallet has open and this process never opened.

A round is opened and debited; the RGS restarts, or the player returns on
another instance. The round exists, the wallet has its state, and the RGS
remembers nothing — so every later round is refused and the player is stuck.
Until now the only answers were to forfeit it or settle it behind their back.

`SessionInfo.walletOpenRound` carries it, and at INIT the orchestrator rebuilds
the round from it: the bet from the index and the ladder, the cost from the
mode's stake, and — the part only the math can answer — what the player is
being asked, via the new optional `ComplexMath.resume(state)`. The player lands
back in the round and finishes it.

`OpenComplex.modeId` lets an adapter record which mode a round belongs to, so
the resolver does not have to guess whose state it is holding. Without one, it
asks each complex math to resume the state and takes the first that accepts —
`resume` is required to throw on a state that is not its own, which is what
makes that a question rather than a guess.

It refuses rather than guesses in three cases, each of which would mean
settling a round under rules it was not played by: a mode that no longer
exists, a math version that no longer matches, and a bet index off the
session's ladder. The round stays open on the wallet and recoverable by hand.
