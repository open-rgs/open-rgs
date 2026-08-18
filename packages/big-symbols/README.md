# @open-rgs/big-symbols

One symbol across a block of cells.

```bash
bun add @open-rgs/big-symbols
```

```ts
import { placeBig } from "@open-rgs/big-symbols";

const g = placeBig(grid, { pos: { col: 1, row: 1 }, width: 2, height: 2 }, "WILD");
```

## Repeated cells, no overlay

A big symbol is written as the same symbol across every cell it covers. No marker, no parallel geometry. That is what makes it work with every evaluator for free - and it matches what players are paid.

## Fit is not obvious

A 2x2 needs two adjacent columns that are both tall enough at those rows. On a multiways board where one reel drew a height of two, a block that fits everywhere else does not fit there.

## Refuse rather than clip

A clipped 2x2 is a 2x1 pretending to be one: it pays less than the game promised, and by then it is just symbols, so nothing downstream can tell. Random placement returns the board unchanged when nothing fits, because a feature that cannot place is an outcome to price rather than a crash.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/big-symbols>

## License

MIT: (c) open-rgs contributors
