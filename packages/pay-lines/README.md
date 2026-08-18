# @open-rgs/pay-lines

Longest run, paid once.

```bash
bun add @open-rgs/pay-lines
```

```ts
import { evalLines, rowLines } from "@open-rgs/pay-lines";
import { totalMultiplier } from "@open-rgs/paytable";

const LINES = rowLines(5, 3);

const wins = evalLines(grid, LINES, PAY, { roles });
totalMultiplier(wins);
```

## Anchored, and paid once

A payline is a row index per column. Evaluation walks it left to right and pays the longest qualifying run - paying every prefix as well roughly doubles a game's RTP.

## A wild-opening run is ambiguous

It can be read as the wild's own symbol or as whatever it substitutes for further along. The convention is to pay whichever is worth more; reading it only as the wild silently underpays the best board in the game.

## Both ways compete

A game paying from either end evaluates both directions and keeps the better one. Paying both would double-count a run that spans the whole grid.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/pay-lines>

## License

MIT: (c) open-rgs contributors
