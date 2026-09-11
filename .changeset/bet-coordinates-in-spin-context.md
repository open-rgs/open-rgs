---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

`SpinContext` now carries the round's `betIndex` and `priceMultiplier`.

Math was currency-blind and also stake-blind: it could not tell a 0.10 round
from a 10.00 one. That rules out a whole class of ordinary mechanics — a meter
that fills in proportion to the stake, a ladder whose rungs differ per tier —
unless the client sends its bet level in `params`, where a client that lies
about it desyncs the mechanic from the money.

Both fields come from `computeBet`, so they are the same numbers the wallet is
charged against: the client's choice, the session default, or the bet a promo
locked the round to. Currency-blindness is untouched — an index is not an
amount, and the win is still `multiplier × bet` with `bet` owned by the
orchestrator.

Additive and optional: every existing math keeps compiling and behaving
identically.

`openComplex` now also stamps `mathVersion`, which `settleSimple` and
`closeComplex` already did. Without it the adapter had no version to write at
open and a round reported two different state-format versions across its own
lifetime.
