---
"@open-rgs/contract": minor
"@open-rgs/core": minor
"@open-rgs/platform-mock": minor
"@open-rgs/adapter-test-kit": minor
---

Mid-round money: a step can now take a stake or pay an award without closing the round.

A round has never really been one debit and one credit. Buying a respin takes money while the round continues; a free-spin feature that pays per spin gives money back before the round is over. Until now both had to be smuggled into the opening bet or held back until close, which makes an operator's ledger a work of fiction.

`StepOutcome` gains optional `stake` and `award` multipliers, and `PlatformAdapter` gains optional `stakeComplex` and `awardComplex`. Both are optional on purpose: a wallet that models a round the old way stays conformant, and a game that asks such a wallet for a mid-round movement fails the step with a clear error rather than playing on with money nobody agreed to move.

The orchestrator takes before it gives, raises the round's cost by a mid-round stake so the max-win cap scales with what the player actually paid, and deducts mid-round awards from that cap so a round cannot pay its ceiling once per step and again at close. Keys are deterministic per step, so a resent step is the same movement.
