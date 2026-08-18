# @open-rgs/scatters

The trigger rate is a parameter, not an emergent property.

```bash
bun add @open-rgs/scatters
```

```ts
import { withScatters, oneInFor, probabilityOfAtLeast } from "@open-rgs/scatters";

const config = {
  symbol: "SC",
  count:  { 0: 9000, 1: 700, 2: 250, 3: 45, 4: 5 },
};

oneInFor(config, 3);
probabilityOfAtLeast(config, 3);
```

## Declared, not discovered

With a natural scatter the trigger rate emerges from per-cell probability and grid size, and you tune it by guessing a weight and re-simulating. Draw the board with the scatter at weight zero and spawn instead, and the count distribution becomes the trigger rate.

## One per reel, and which reels

At most one per reel is the genre norm, and it is what makes the count distribution exactly controllable. Excluded reels never receive one.

## Protected symbols stay

A wild the player can see is about to pay must not be eaten. If protections leave too few legal cells, the spawn places what it can and reports both numbers - throwing would crash a legitimate spin, and silence would break the declared rate with nothing to notice it.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/scatters>

## License

MIT: (c) open-rgs contributors
