# @open-rgs/pay-cluster

A wild belongs to every cluster it touches.

```bash
bun add @open-rgs/pay-cluster
```

```ts
import { evalAllClusters, clustersOf } from "@open-rgs/pay-cluster";

const wins = evalAllClusters(grid, CLUSTER, { roles });

clustersOf(grid, "HIGH", roles);
```

## Orthogonal flood fill

A win is a group of the same symbol connected up, down, left or right - never diagonally - paid by how many cells it holds.

## Wilds are the whole difficulty

A wild sitting between two clusters is legitimately part of both. So the fill runs per symbol and consumes only real matches - consume the wild for the first and the second silently shrinks by one, with nothing on the board looking wrong.

## Never seeded from a wild

Growing a cluster around a symbol that is not actually present would invent wins out of a lone wild. A wild-only region pays nothing: with no real symbol to be, there is no paytable row to read.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/pay-cluster>

## License

MIT: (c) open-rgs contributors
