# @open-rgs/paytable

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Gaps found while auditing the extension set against what the genre actually
  uses.

  **cascade** reports which cells were refilled on each step. Not the same list
  as `cleared`: gravity moves survivors down, so the holes that get filled are
  at the top of every column that lost a cell, wherever the win happened to be.
  A client animating the drop needs that, and so does any mechanic that counts
  only new symbols.

  **big-symbols** gains the expanding symbol. A block is a symbol that ARRIVES
  big; an expanding symbol arrives normal and grows to fill its reel, which is
  the book game's special symbol and the expanding wild. `expandSymbol` fills
  every column holding it (each to its own height, so a ragged reel is filled
  short), `columnsHolding` names the candidates, and `expansionCells` reports
  what would be written without writing it, for a client that animates the
  growth first.

  **paytable** has tests of its own. It was covered only through the four
  evaluators that import it, so a change here failed somewhere else or nowhere,
  in the one module where all four agree about what a symbol is worth and what a
  wild may stand in for.
