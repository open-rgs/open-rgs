# @open-rgs/fill

Weighted draws, one cell at a time.

```bash
bun add @open-rgs/fill
```

```ts
import { fillWeights } from "@open-rgs/fill";

const reels = fillWeights(SHAPE, { LOW: 55, MID: 25, HIGH: 12, WILD: 5, SC: 3 });

const board = reels(host.rng_next);
```

## The strip replacement

Every cell drawn independently from one weighted set. This deliberately does not do adjacency - that belongs to markov, layered on top - because most balancing work is frequency work and should not require thinking about neighbours.

## Per-column sets

The classic way to differentiate reels: a wild that can only land on the middle three. A short list is an authoring mistake that would otherwise surface as an undefined symbol mid-spin, so it throws at build time.

## Counting without simulating

Cells are independent under these generators, so expectation is the sum of per-cell probabilities. That makes a whole class of questions arithmetic rather than a simulation run.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/fill>

## License

MIT: (c) open-rgs contributors
