# @open-rgs/simulator

Per-mode RTP + hit-rate simulator and report generator for open-rgs
games. Usable as a library or via the `open-rgs-sim` CLI.

## Runtime

**Bun is required** (`engines.bun >= 1.0.0`). This package publishes raw
TypeScript (no `dist/`) and its `bin` is a `.ts` file with a
`#!/usr/bin/env bun` shebang, so run the CLI with **`bunx`**  - not
`npm install -g` on a Node-only machine. See ADR-001 for why.

## Install

```bash
bun add -d @open-rgs/simulator
```

## CLI

```bash
bunx open-rgs-sim <manifest-module> [--spins N] [--seed N] [--bet N] \
                  [--out DIR] [--format md|html|json|all] [--skip-internal] [--quiet]
```

`<manifest-module>` is a path to a module that exports a `GameManifest`
(from `defineGame`)  - as `default`, `manifest`, or `buildManifest`; a
function export is called with `{ seed }` so it can seed the math RNG.
Reports are written to `--out` (default `./reports`) in the chosen
`--format` (default `all`).

## Use

Write a `simulate.ts` next to your game's `index.ts`:

```ts
import { simulate, mdReportSet, mulberry32 } from "@open-rgs/simulator";
import { loadLuaMath } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";

// Seed the MATH's rng so spins are reproducible.
const math = await loadLuaMath("./maths/spin.lua", {
  rng: mulberry32(42),
});

const manifest = defineGame({
  id: "hello-spin",
  declaredRtp: 0.95,
  defaultMode: "default",
  modes: { default: { math, stakeMultiplier: 1 } },
});

const reports = await simulate(manifest, { spinsPerMode: 100_000 });
console.log(mdReportSet(reports));
```

Run it: `bun src/simulate.ts > report.md`.

## What you get back

One [`SimulationReport`](src/report.ts) per mode:

```
# Simulation  - hello-spin / default

math hello-spin@0.2.0 (simple)

- Measured RTP: 94.87% (declared 95.00%, delta -0.13%)
- Hit rate: 38.74%
- Spins: 100,000 . Bet: 1u/spin . Time: 412ms
- Stake multiplier: 1x . Internal: no

## Multiplier distribution
| stat   | value   |
|--------|---------|
| min    | 0.0000  |
| mean   | 0.9487  |
| stddev | 4.2814  |
| p50    | 0.0000  |
| p90    | 1.5000  |
| ...    |         |

## Outcome types
| type    | count    | share   |
| ------- | -------- | ------- |
| loss    | 61,260   | 61.26%  |
| win     | 37,824   | 37.82%  |
| scatter | 916      | 0.92%   |

## Next-mode routes
| target     | count | share |
| ---------- | ----- | ----- |
| free-spins | 916   | 0.92% |
```

## Reproducibility note

The simulator's own `seed` option only drives its **complex-round step
strategy** ("random" / "first"). To make the *math's* spins
reproducible, seed the math at `loadLuaMath` time:

```ts
import { mulberry32 } from "@open-rgs/simulator/rng";
const math = await loadLuaMath("./maths/spin.lua", { rng: mulberry32(42) });
```

> ⚠️ **Simulation/dev only.** `mulberry32` is a 32-bit, fully-predictable
> PRNG  - never route it into a production `loadLuaMath({ rng })`. It is
> tagged so `loadLuaMath` throws if it sees it under `NODE_ENV=production`.
> Production outcome determination requires a certified CSPRNG (Spec 03).

The same `mulberry32` is exported from both `@open-rgs/simulator` and
its `/rng` subpath, so you can import it into the simulator script *or*
into a separate math-loading harness without dragging the whole sim in.

## Complex-round strategies

For complex rounds (open / step / close with player actions) the
simulator picks actions via:

| strategy | behaviour                                            |
|----------|------------------------------------------------------|
| `"first"`| Always `awaiting.options[0]`. Default. Deterministic. |
| `"random"` | Picks uniformly from `awaiting.options` using the simulator's seeded rng. |

Bespoke strategies (e.g., always-gamble, always-take) aren't first-
class yet  - write your own loop using the orchestrator's
`OrchestratorAPI` if you need them.

## Caveats

- `next_mode` and `carry` are recorded but **not followed**. Each
  mode is simulated in isolation. Cross-mode session RTP needs a
  different harness; this one measures per-mode math behaviour.
- Free-round campaigns aren't simulated either  - those are platform-
  side, and the simulator skips the platform adapter entirely.
- The whole reel-distribution is held in memory (`number[]` of length
  `spinsPerMode`) so percentile and stddev can be computed. 100k spins
  ~= 800kB. For 10M-spin runs, refactor to streaming quantile sketches.
