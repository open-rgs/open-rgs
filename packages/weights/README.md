# @open-rgs/weights

The number you read is the number you get.

```bash
bun add @open-rgs/weights
```

```ts
import { sampler } from "@open-rgs/weights";

const symbols = sampler({ LOW: 60, MID: 30, HIGH: 9, WILD: 1 });

symbols.probabilityOf("WILD");
symbols.distribution();
symbols.pick(host.rng_next());
```

## Probability you can read

A reel strip encodes odds indirectly - you move symbols around an array to shift them. A weighted set answers the question directly, and that is the whole balancing story: RTP is a sum of probability times payout.

## Zero weight means unreachable

A symbol that exists in the game but cannot be drawn in this mode is a real thing - a scatter excluded from a respin set. It stays in the set, reports probability zero, and never comes out at any draw.

## Refusing beats under-delivering

A placement that declared three symbols has already priced three into its RTP. Handing back two would corrupt the model with nothing downstream able to notice, so it throws instead.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/weights>

## License

MIT  - (c) open-rgs contributors
