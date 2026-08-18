# @open-rgs/meters

Collect five of these and something happens.

```bash
bun add @open-rgs/meters
```

```ts
import { meter, collect, progress } from "@open-rgs/meters";

const CFG = { thresholds: [{ at: 3, award: "MINI" }, { at: 6, award: "MINOR" }] };

const { meter: next, awards } = collect(state.meter, coinsThisSpin, CFG);
```

## One spin can cross two thresholds

A spin that collects three at once pays every threshold it passed, in ascending order. Paying only the highest is the common bug, and it stays invisible until someone reconciles a big spin against the paytable.

## A threshold never fires twice

`awarded` is part of the meter, so a meter that keeps counting past a threshold does not keep paying for it.

## Filling it keeps the remainder

Under `repeat`, a spin that overshoots the top starts the next lap with what was left over, and a remainder that already reaches the first threshold awards it straight away: the player collected those symbols.

## The cadence is arithmetic

`spinsToFill(cfg, perSpin)` is the top threshold over what a spin collects on average, so a meter can be tuned before it is simulated.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/meters>

## License

MIT: (c) open-rgs contributors
