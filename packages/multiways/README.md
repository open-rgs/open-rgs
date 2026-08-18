# @open-rgs/multiways

Each reel draws its own height, every spin.

```bash
bun add @open-rgs/multiways
```

```ts
import { heights, multiwaysFillWeights } from "@open-rgs/multiways";

const H = heights({ 2: 20, 3: 25, 4: 25, 5: 15, 6: 10, 7: 5 }, 6);

const reels = multiwaysFillWeights(H, { LOW: 55, HIGH: 12, WILD: 5 });
```

## Heights are the mechanic

Each reel independently draws a height, and the ways available that spin are the product. Six reels at two to seven span 64 ways to 117,649. Because a shape is already a list of column heights, this needed almost no code.

## The marketing number

Reel heights are drawn independently, so the expected board ways is the product of the per-reel expectations. Correlate the reels and that stops being true.

## Do not rescale by ways

A k-column win carries a multiplier scaling as h to the k, while the board scales as h to the reel count. Only a paytable weighted entirely on full-length runs tracks board ways; everything shorter scales slower, and short runs hold most of the expected value.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/multiways>

## License

MIT: (c) open-rgs contributors
