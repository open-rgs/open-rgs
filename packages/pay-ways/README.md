# @open-rgs/pay-ways

Paid by the product of per-column counts.

```bash
bun add @open-rgs/pay-ways
```

```ts
import { evalWays, totalWays } from "@open-rgs/pay-ways";

const wins = evalWays(grid, PAY, { roles });

wins[0].ways;
totalWays(grid);
```

## Counting ways

No paylines. A symbol pays if it appears on consecutive columns from the first reel, and the payout is multiplied by the number of distinct paths through them.

## A gap ends the run

Counting every column the symbol appears on, gap or not, inflates both the count and the ways multiplier. Ways games are dense, so this bug is far more expensive here than on lines.

## Variable heights need no change

This never reads the shape. It counts actual matches per column, so a board whose reels drew different heights this spin works unchanged.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/pay-ways>

## License

MIT: (c) open-rgs contributors
