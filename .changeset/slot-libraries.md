---
"@open-rgs/grid": minor
"@open-rgs/weights": minor
"@open-rgs/selectors": minor
"@open-rgs/fill": minor
"@open-rgs/markov": minor
"@open-rgs/recipes": minor
"@open-rgs/holdwin": minor
"@open-rgs/paytable": minor
"@open-rgs/pay-lines": minor
"@open-rgs/pay-ways": minor
"@open-rgs/pay-anywhere": minor
"@open-rgs/pay-cluster": minor
"@open-rgs/cascade": minor
"@open-rgs/multiways": minor
"@open-rgs/big-symbols": minor
"@open-rgs/scatters": minor
---

**Sixteen slot libraries, first release.** One small package per concern, each
usable on its own. Nothing in core depends on any of them, and a game can take
one and ignore the rest.

The board and its filling: `grid` (shape is a height per column, so a ragged
reel set is the ordinary case rather than a special one), `weights` (exact
sampling, where the number you read is the number you get), `selectors` (name a
set of cells once and reuse it), `fill` (draw a board), `markov` (stickiness
whose stationary distribution provably equals the base weights, so making runs
clumpier does not silently move RTP), `recipes` (draw from a mixture of named
board recipes rather than stamping symbols on afterwards).

Paying: `paytable`, plus four evaluators that share nothing but the paytable -
`pay-lines`, `pay-ways`, `pay-anywhere`, `pay-cluster`.

Mechanics: `cascade` (tumbles and the multiplier ladder), `holdwin` (the
collector / payer / multiplier / upgrader / spawner algebra, which is one
mechanism parameterised by selectors), `multiways` (variable reel heights),
`big-symbols` (blocks spanning cells), `scatters` (spawn scatters as a declared
event, with reel exclusions and at most one per reel).

Two worked games ship as examples rather than as packages: `demo-holdwin` and
`demo-tumble`, both simulated and RTP-checked.

They live in this repo rather than their own. The docs site that documents them
is here, this repo's rule is that spec and code land in the same PR, and a
split would have guaranteed the two drift.
