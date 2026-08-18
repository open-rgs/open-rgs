---
"@open-rgs/holdwin": minor
"@open-rgs/pay-ways": minor
"@open-rgs/paytable": minor
"@open-rgs/scatters": patch
"@open-rgs/cascade": patch
---

Four ways a slot library could quietly pay the wrong number.

**holdwin** - `collector()`'s jackpot table was optional and defaulted to
zeros, so collecting a GRAND without passing one absorbed it at nothing and
emptied the cell. Valuing a tier coin without the ladder is now an error.
`upgrader()` gains `cash: "promote-if-better" | "skip"`; the default stays
`"promote"` because existing games are priced against it, but the doc now says
plainly that promoting a 50x cash coin into a 10x MINI is a downgrade.

**pay-ways** - a wild with its own paytable row was evaluated as its own symbol
AND counted inside the run it substituted into, so the same cells paid twice on
every board with a wild. Wilds are excluded from the symbol walk unless
`wildsPaySeparately` says otherwise.

**paytable** - a table that pays at 3 and 5 but not 4 pays NOTHING for four of
a kind, because evaluators look up the exact run length. That is the player's
better board and the one nobody tests. `paytable()` now refuses a gap, with
`{ allowGaps: true }` for a game that means it; `bands()` remains the way to
express "N or more".

**scatters** - `spawnOn` rebuilt its count sampler on every spin.
**cascade** - `truncated` claimed to distinguish "hit the cap" from "had more
to give", which it cannot see; the doc now says what it means.
