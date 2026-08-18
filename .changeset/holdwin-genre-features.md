---
"@open-rgs/holdwin": minor
---

The rest of the genre, as small functions over the board.

**The landing loop is a helper now.** Every hold-and-win writes the same
per-cell draw, so `landCoins(grid, chance, coins, next)` is it. The other
shape ships too: `landCount(grid, count, coins, next)` drops a drawn number
of coins into random empty cells, with `countSet({ 1: 50, 2: 30 })` for a
weighted count. They are different games rather than different spellings, so
both are named: per-cell trials taper as the board fills and cycles end on
their own, while a drawn count keeps the rate flat and pushes far more cycles
to a full board, which moves the largest single term in the feature's RTP.

**`runRespins` is the cycle.** Spin, apply, stop when the counter runs out or
the board fills, with a `maxSpins` backstop so a bug in the draw cannot hang a
round, and an `onSpin` hook where an expansion, an awarded spin or an effect
belongs.

**Mystery coins.** `mystery()` lands face down: it takes its cell and resets
the counter like any coin, and has no value until `revealMystery` turns it
over, either to one shared value (the convention, and a variance decision -
same mean, roughly double the standard deviation on four cells) or one per
cell. Asking what an unrevealed coin is worth throws, so a collector or a
settle that runs before the reveal fails loudly instead of pricing the board
at zero.

**Multipliers printed on cells.** `addCellMultiplier` puts a factor on a
position, with `add`, `multiply` or `replace` for what a second one landing
there does, and `settleRespins(..., { cellMultipliers })` applies it to
whatever finished in each cell. Keyed by position, so factors survive a board
that grows. The full-board award is not scaled: it belongs to the board.

**Extra spins.** `awardRespins(state, n)` adds to the counter, where a
landing resets it, which is why the "+1 spin" symbol is worth most late.

**A board that grows.** `expandBoard(state, shape, { anchor })` unlocks rows
or reels mid-cycle. Locked coins keep their cell, new cells open empty and
become landing targets immediately, and `full` is recomputed against the
bigger board. Shrinking is refused, because a locked coin has nowhere to go.
