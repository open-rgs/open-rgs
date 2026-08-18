# @open-rgs/gamble

Risk what you just won.

```bash
bun add @open-rgs/gamble
```

```ts
import { gambleLadder, stepEdge } from "@open-rgs/gamble";

const STEP = { chance: 0.49, on: 2 };     // 2% edge
stepEdge(STEP);                           // 0.02

const round = gambleLadder(win, STEP, playerWantsToContinue, host.rng_next, { maxSteps: 5 });
```

## The interesting number is the edge, not the payout

Double-or-nothing at exactly `p = 0.5` returns everything staked, so a game offering it returns more than its base RTP to any player who uses it. Every function takes the chance explicitly and reports what the round is worth, so the edge is a number you chose.

## A fair ladder changes variance, not RTP

`ladderReturn(step, steps)` is `stepReturn(step) ** steps`: 1 forever when the step is fair, geometric decay when it is not. `survivalChance` says what the player is really betting against, which is usually smaller than it feels.

## Every gamble needs a limit of its own

`maxSteps` and `maxStake` end the round. Without them the max win is unbounded and the engine's payout cap becomes the only thing stopping it, which is a payout rule standing in for a game rule.

## Docs

Worked examples and animated explainers: <https://open-rgs.dev/extension/gamble>

## License

MIT: (c) open-rgs contributors
