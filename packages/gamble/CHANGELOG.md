# @open-rgs/gamble

## 0.2.0

### Minor Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Four more of the genre's classics, and the refill helpers a cascade needed.

  **@open-rgs/symbols** is what a symbol turns into after the board is drawn:
  mystery tiles that reveal together (a variance decision, not a cosmetic one),
  transforms and one-rung upgrade ladders, walking wilds that are re-applied and
  then stepped, wilds that carry a multiplier, and symbols that count more than
  once. Each has one rule that decides whether the game is priced right, and
  each rule is the reason its function exists: reveal before evaluating,
  transform order is the behaviour, multipliers on one win multiply rather than
  add, and a split counts without occupying.

  **@open-rgs/gamble** prices the oldest feature in the genre. Double-or-nothing
  at exactly one half returns everything staked, so a game offering it returns
  more than its base RTP to any player who uses it: `stepEdge`, `fairChance`,
  `ladderReturn` and `survivalChance` make that a number you chose rather than
  one a report finds later. `gambleLadder` and `collectOrRisk` run the round,
  and both insist on a limit of their own, because the engine's payout cap is a
  payout rule standing in for a game rule.

  **@open-rgs/meters** is the collection counter: thresholds that pay in
  ascending order when one spin crosses several, a threshold that never fires
  twice, a repeat mode that carries the remainder into the next lap, and
  `spinsToFill` so the cadence can be tuned as arithmetic.

  **@open-rgs/cascade** gains the refill helpers. `refillPerColumn` keeps a
  game whose columns differ from flattening into one set on every tumble, and
  `refillAvoiding` does no-instant-rewin rejection sampling with an attempt cap -
  documented as what it is, since rejection sampling changes the distribution
  and lowers the cascade's RTP by an amount that depends on the paytable.
