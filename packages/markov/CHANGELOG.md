# @open-rgs/markov

## 0.2.0

### Minor Changes

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
