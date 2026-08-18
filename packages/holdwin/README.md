# @open-rgs/holdwin

A landing resets the counter.

```bash
bun add @open-rgs/holdwin
```

```ts
import { triggers, beginRespins, stepRespins, isCycleOver, settleRespins } from "@open-rgs/holdwin";

const CONFIG = { respins: 3, fullBoardAward: "GRAND" };

if (triggers(grid, 6)) {
  let s = beginRespins(grid, CONFIG);
  while (!isCycleOver(s)) s = stepRespins(s, landed, CONFIG);
}
```

## The cycle

N coins on a base board trigger respins. Coins lock, and every new coin resets the counter rather than decrementing it. That single rule is what makes the feature feel alive - and why a cycle has no natural end, so the max-win cap is what makes the round finite.

## Five mechanics, one shape

Collector, payer, multiplier, upgrader and spawner are the same mechanism with different selectors. Adding "collect only from the same column" is a selector, not a new engine.

## Tiers resolve through one table

A jackpot coin carries a tier, not a number, so retuning GRAND never means touching every coin. A collected coin is emptied rather than removed - it still fills the board but cannot be harvested twice.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/holdwin>

## License

MIT: (c) open-rgs contributors
