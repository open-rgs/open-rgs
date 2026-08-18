# @open-rgs/paytable

One shared notion of payout, wild and scatter.

```bash
bun add @open-rgs/paytable
```

```ts
import { paytable, substitutes } from "@open-rgs/paytable";

const PAY   = paytable({ HIGH: { 3: 10, 4: 50, 5: 200 } });
const roles = { wilds: ["WILD"], scatters: ["SC"] };

substitutes("WILD", "HIGH", roles);
substitutes("WILD", "SC",   roles);
```

## One table, four evaluators

Lines, ways, anywhere and cluster all read this, so a symbol means the same thing in each. When each carried its own idea of a wild, a game using two of them could disagree with itself and the two RTPs would quietly differ.

## Bands for cluster games

Cluster games pay by size range while a paytable stores exact counts, so there is never interpolation to reason about. bands() bridges the two.

## Watch the top band

The top band is open-ended: it runs from its start all the way to maxCount. On a five-reel grid seven scatters is impossible, so the intuition is that it is a lottery ticket. On 49 cells it is not.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/paytable>

## License

MIT: (c) open-rgs contributors
