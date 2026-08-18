# @open-rgs/symbols

What a symbol turns into after the board is drawn.

```bash
bun add @open-rgs/symbols
```

```ts
import { revealMystery, upgradeLadder, stepWalkers, winFactor } from "@open-rgs/symbols";

const { grid, revealed } = revealMystery(board, "MYSTERY", symbols, host.rng_next);
```

## Reveal before you evaluate

A mystery tile is not a paying symbol. An evaluator that sees one reads a board the player never had.

## Shared reveals are a variance decision

All tiles turning over to the same symbol pays the same on average as one draw per tile, and swings far harder, because the tiles are then perfectly correlated.

## Transform order is not a detail

`LOW -> HIGH` followed by `HIGH -> WILD` turns the lows into wilds. `upgradeLadder` walks the ladder from the top down so one call moves each symbol exactly one rung.

## Multipliers on one win multiply

Two 2x wilds in the same line pay 4x, not 3x. `winFactor` combines the cells a win covers, and a win touching no multiplier is unchanged.

## Splits count, they do not occupy

A split symbol counts twice in its column, which doubles the ways for that column. `pay-ways` counts cells and cannot know a cell means two, so `waysWithSplits` does that part.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/symbols>

## License

MIT: (c) open-rgs contributors
