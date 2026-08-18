# @open-rgs/grid

Shape is a height per column, not width by height.

```bash
bun add @open-rgs/grid
```

```ts
import { rect, makeGrid } from "@open-rgs/grid";

const SHAPE  = rect(5, 3);
const RAGGED = [4, 5, 5, 5, 5, 4];

const board = makeGrid(RAGGED, () => "LOW");
```

## Ragged is not a special case

A shape is a list of column heights. Rectangular boards are the case where every entry happens to match, so a 4-5-5-5-5-4 reel set needs no separate code path.

## Off the grid reports, never throws

On a ragged board an out-of-range row is normal, not exceptional - a payline crossing a short reel simply has no cell there. So reads report their absence instead of raising.

## Neighbours are asked for

Cluster evaluation walks neighbours, and on a ragged board a cell can have a left neighbour and no right one. Computing that from width and height gets it wrong; asking the shape does not.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/grid>

## License

MIT: (c) open-rgs contributors
