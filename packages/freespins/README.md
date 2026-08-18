# @open-rgs/freespins

The bookkeeping between free spins.

```bash
bun add @open-rgs/freespins
```

```ts
import { spinsFor, beginFreeSpins, runFreeSpins } from "@open-rgs/freespins";

const TABLE = { 3: 10, 4: 15, 5: 25 };          // scatters -> spins
const CFG = { ladder: { steps: [1, 2, 3, 5] } };

const feature = runFreeSpins(
  beginFreeSpins(spinsFor(TABLE, scatters), CFG),
  (state, next) => ({ win: playOneSpin(state, next) }),
  host.rng_next,
  CFG,
);
feature.total;   // a multiple of bet, multipliers already applied
```

## A spin is paid at the multiplier that was showing

The global multiplier lives in the state, and `playSpin` applies it before the ladder moves. Paying a spin at the multiplier it *left behind* is a small error that compounds over a whole feature, and it looks right in a screenshot.

## A retrigger adds, it never resets

`retrigger(state, extra)` extends what is left, which is why a retrigger late in a feature is worth more than an early one. `maxRetriggerSpins` bounds a feature that can retrigger indefinitely, because the max-win cap is a payout rule rather than a statement about round length.

## More scatters than the table lists pays its top entry

A six-scatter board on a table that stops at five is a better board, not a broken one. Awarding it nothing is the kind of bug that only shows up on the boards players remember.

## Sticky cells are re-applied, not remembered

`applySticky` writes held cells onto each freshly drawn board. A sticky symbol that is only written on the spin it landed is not sticky, and nothing else in the round will tell you.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/freespins>

## License

MIT: (c) open-rgs contributors
