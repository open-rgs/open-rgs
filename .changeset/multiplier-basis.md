---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

`GameMode.multiplierBasis` — what a win multiplier is a multiple of

open-rgs has always settled `win = multiplier × effectiveCost`: a multiple of
what the round cost. That is one of the two conventions in use. The other —
the one most published paytables are written in — is that the multiplier is a
multiple of the **bet**, and the price of a feature buy has nothing to do with
what a win pays. "Max win 10000x" means 10000 times the bet whether the
feature was entered for 1x or for 2100x.

A game on the second convention running under the first overpays by the buy's
price multiplier, which at 2100x is not a rounding error. It also records a
multiplier the game's own paytable screen contradicts: a max win stored as
4.76x.

```ts
modes: {
  "super-core": {
    math,
    stakeMultiplier: 2100,     // what the round costs
    multiplierBasis: "bet",    // what a multiplier is OF
    maxWinMultiplier: 10_000,  // read in the same basis
  },
}
```

Defaults to `"cost"`, so no existing game changes. The basis is resolved when
a round opens and stored with it, so a config change cannot re-price a round
already in flight. The mode catalog now reports `multiplierBasis`, because a
client rendering `x{multiplier}` cannot otherwise know what the x is of.
