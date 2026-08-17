# @open-rgs/selectors

One primitive serving placement and hold-and-win targeting.

```bash
bun add @open-rgs/selectors
```

```ts
import { all, cols, rows, holding } from "@open-rgs/selectors";

cols([0, 1])(grid, host.rng_next);
holding("WILD")(grid, host.rng_next);
```

## Naming cells

Placement and hold-and-win targeting are the same shape: pick some positions, then act on them. Only the first half varies, so it lives here once.

## They compose

Set operations rather than options. Adding a rule means combining selectors, not growing a config object.

## Random draws are stable

Order is column-major and stable. A selector returning set-iteration order would make a seeded replay diverge between engine versions - a bug that only surfaces in a certification rerun.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/selectors>

## License

MIT  - (c) open-rgs contributors
