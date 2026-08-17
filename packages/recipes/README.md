# @open-rgs/recipes

Every board comes from exactly one declared recipe.

```bash
bun add @open-rgs/recipes
```

```ts
import { recipes } from "@open-rgs/recipes";

const board = recipes([
  { name: "base",        p: 0.94, draw: reels },
  { name: "two-scatter", p: 0.05, draw: tease },
  { name: "high-stack",  p: 0.01, draw: stacked },
]);

const { grid, recipe } = board(host.rng_next);
```

## A mixture, not a decoration

Draw a board and then stamp extra symbols on it and the real distribution stops matching the one RTP was computed from, silently. A mixture avoids that: RTP is a sum over recipes, each independently measurable.

## A tease is a real draw

The tease board goes through the pay evaluator honestly. You bias which boards appear, at a rate you wrote down, and never fake an outcome - which is also what keeps near-miss behaviour on the right side of the rules.

## Placement building blocks

A recipe is written as a pipeline rather than a special case buried inside the base draw. Probabilities must sum to 1: a mixture summing to 0.98 misprices every spin by an amount nobody will notice.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/recipes>

## License

MIT  - (c) open-rgs contributors
