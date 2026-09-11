---
"@open-rgs/adapter-artube": minor
---

Surface the round the wallet has open and this process does not.

A round is opened, and debited, by one process; that process dies, or the pod
rolls, or the player returns on another instance. The RGS has no memory of the
round, the wallet still does, and every subsequent round on that session is
refused with `InvalidRoundOperation: Round is already opened` — the player is
stuck until someone closes it by hand.

Artube's `SessionInfo` answers the question the contract cannot ask yet
(ADR-007): `last_round` with no `finished_at` is the open round, with its
state, its `round_version` and the price it was opened at.
`adapter.openRoundFor(sessionId)` returns it after every `openSession`, and the
round is adopted so a `closeComplex` for it works — the version is the wallet's
own rather than a guess.

What to settle it at stays the game's decision: it owns the math that can value
the state, and whether the policy is to pay what was on the table or forfeit
it.
