# @open-rgs/cascade

Clear, fall, refill, repeat.

```bash
bun add @open-rgs/cascade
```

```ts
import { clear, collapse, refill, tumble } from "@open-rgs/cascade";

const next = tumble(grid, winningCells, (n) => symbols.pick(n()), host.rng_next);
```

## Gravity is per column

A short reel drops its symbols a shorter distance. Treating the board as a rectangle mixes symbols between columns - a bug that reads as a shuffle rather than a fall, and still looks plausible on screen.

## The ladder applies per step

It multiplies that step's own win, never the running total. Applying it to the total compounds across steps and inflates RTP badly.

## The loop is bounded

A refill can always produce another win, so in principle a cascade never ends. Unbounded, one unlucky spin hangs the process; the cap turns that into a finite, auditable round.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/cascade>

## License

MIT  - (c) open-rgs contributors
