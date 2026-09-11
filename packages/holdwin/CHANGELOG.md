# @open-rgs/holdwin

## 0.2.0

### Minor Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Four ways a slot library could quietly pay the wrong number.

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - The rest of the genre, as small functions over the board.

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **Sixteen slot libraries, first release.** One small package per concern, each
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

### Patch Changes

- Updated dependencies [[`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928)]:
  - @open-rgs/grid@0.2.0
  - @open-rgs/weights@0.2.0
  - @open-rgs/selectors@0.2.0
