# @open-rgs/markov

Changes how clumpy reels look. Provably does not change frequency.

```bash
bun add @open-rgs/markov
```

```ts
import { stackyFill } from "@open-rgs/markov";

const BASE = { LOW: 60, MID: 30, HIGH: 10 };

const flat   = stackyFill(SHAPE, BASE, 0);
const stacky = stackyFill(SHAPE, BASE, 0.8);
```

## One knob for feel

Independent draws give exact frequency and no adjacency, so reels never feel like reels. Strips give adjacency but tangle it with frequency. A Markov chain over each column gives both, separately.

## Frequency does not move

Under sticky(base, s) the chain's stationary distribution is exactly base, for every s below 1. So stickiness is a pure feel knob - turn it up for stacks and your RTP does not shift.

## How tall are the stacks

Run length is what stickiness is actually tuned against, and guessing it from spin footage is slow. It is a geometric distribution, so it has a closed form.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/markov>

## License

MIT: (c) open-rgs contributors
