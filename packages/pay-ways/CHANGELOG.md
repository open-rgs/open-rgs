# @open-rgs/pay-ways

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - The last mechanics the library set could not express.

  **@open-rgs/strips** is the classic reel: a fixed sequence per column, a stop
  per spin, and the window it shows. The rest of these libraries prefer weighted
  sets and that preference stands, but three cases are real and pretending
  otherwise helps nobody: a port of an existing game HAS strips, some labs ask
  for the listing itself, and adjacency is a strip's whole point, since what can
  appear above what is fixed by the sequence.

  It ships the counting that makes a strip as readable as a weighted set, and
  one figure in particular: at-least-one in a window is NOT the row chance times
  the height. On a reel with a three-tall stack that formula gives 1.125, which
  is not a probability, because a stacked symbol appears in several rows of the
  same window - exactly where a strip game puts its stacks. The expected COUNT
  is height times the row chance, and that one is exact. Both are here so the
  two are not confused for each other.

  **grid** grows: `appendColumn` adds a reel mid-round for the games that do
  that, without renumbering anything, so a payline or a sticky cell written
  against the old board still points where it did.

  **pay-ways** gains `bothWays`, matching pay-lines. The two directions COMPETE
  rather than accumulate, because adding them pays a board-spanning run twice,
  which is the most expensive mistake available in a ways game. Off by default,
  so no existing game starts paying twice.

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

- Updated dependencies [[`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928)]:
  - @open-rgs/paytable@0.2.0
  - @open-rgs/grid@0.2.0
