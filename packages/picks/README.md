# @open-rgs/picks

The bonus round where the player chooses.

```bash
bun add @open-rgs/picks
```

```ts
import { pool, pickN, revealUntil, wheel } from "@open-rgs/picks";

const boxes = pool(["1", "2", "5", "10", "BOMB", "BOMB"]);

pickN(boxes, 3, host.rng_next).picked;                              // pick 3 of 6
revealUntil(boxes, (b) => b === "BOMB", host.rng_next).picked;      // until the bomb
wheel({ MINI: 50, MINOR: 30, MAJOR: 15, GRAND: 5 }).spin(host.rng_next);
```

## Reveals remove what they revealed

A pick round is priced by what it takes off the board. Drawing with replacement instead looks identical on screen and pays a different distribution, and the gap widens with every pick.

## The stop is part of what was picked

`revealUntil` returns the bomb inside `picked`, because the player saw it. A report that hides it cannot be reconciled against the screen.

## The round's shape is arithmetic

`expectedPicksBeforeStop(12, 3)` is 2.25: with three bombs in twelve boxes, a round runs two and a bit prizes on average. `expectedPickTotal` and `wheelValue` do the same for what a round pays, so a bonus can be tuned before it is simulated.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/picks>

## License

MIT: (c) open-rgs contributors
