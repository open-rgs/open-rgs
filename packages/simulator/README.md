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

### Sharding across cores (`--shards N`)

For big certification runs, `--shards N` splits the spins across **N
independently-seeded worker processes** (one per core) and merges the
results  - near-linear speedup with core count:

```bash
bunx open-rgs-sim ./src/manifest.ts --spins 8000000 --shards 8
```

Each shard runs `spins / N` spins with its own derived seed, so the
shards draw **independent RNG substreams**. This requires the module to
export a **factory** `({ seed }) => GameManifest` so each shard can be
re-seeded; a static manifest export is **refused** with a clear error,
because every shard would otherwise replay the identical stream and the
result would be a bogus, over-confident number.

The merged report is **exact** for the cert-critical numbers  - measured
RTP, standard error, 95% CI, verdict, hit rate, outcome-type counts, RTP
contributions, deviations, and the multiplier mean / stdDev / min / max.
The only approximated values are the distribution **percentiles**
(multiplier and observation p50..p99), which are count-weighted across
shards; merged reports carry `sharded.percentilesApproximate` and the
markdown notes it. Use `--shards 1` (the default) for exact percentiles.

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

## Fast batch simulation (WASM + native Zig)

`simulate()` above runs the math one spin at a time (the Lua path). When the
math is a **WASM kernel** that exports `sim_batch`, the whole spin loop runs
*inside* the kernel - 100M+ spins incur no per-spin `JS<->WASM` boundary, just
one crossing per chunk. It uses a seeded in-VM PRNG and the same `decide`
logic as the kernel's production `play`, so the measured RTP is exactly the
shipped math's, on the same sandboxed artifact you serve (nothing to
re-certify).

```ts
import { simulateWasmBatch } from "@open-rgs/simulator";

const report = await simulateWasmBatch("./maths/play.wasm", {
  spins:       100_000_000,
  seed:        42,          // each chunk derives an independent substream
  declaredRtp: 0.95,        // optional; else taken from the kernel's rtp_x10000
});
console.log(report.rtp.measured, report.rtp.verdict, report.hitRate);
```

Measured **~216M spins/sec single-threaded** (~250x the per-spin WASM path).
The returned `WasmBatchReport` carries exact RTP + standard error + 95% CI +
verdict, hit rate, and multiplier min/max/mean/stdDev (from the kernel's
`count/sum/sumsq/min/max/hits` aggregate). Distribution percentiles and
outcome-type / mark breakdowns are *not* produced by the fast path - use the
per-spin `simulate()` for those. Combine with `--shards` for multicore.

### Native "extreme" tier

`simulateNativeBatch(binPath, opts)` runs a native build of the **same**
`kernel.zig` (with `std.Thread` parallelism, so one call uses every core) for
offline certification at billion-spin scale - measured **~1.65B spins/sec**
(100M spins in ~60ms on 10 threads). It is **synchronous**:

```ts
import { simulateNativeBatch } from "@open-rgs/simulator";

const report = simulateNativeBatch("./maths/sim", {
  spins:       100_000_000,
  seed:        42,
  declaredRtp: 0.95,        // required - the native binary carries no RTP
});
```

> ⚠️ The native tier is **unsandboxed** and a *separate* build from the WASM
> you serve, so its soundness rests on a **byte-parity test**: a native
> single-thread slice must be byte-identical to WASM `sim_batch` for the same
> seed (same Zig source, both IEEE-754). Run that test whenever the kernel
> changes, and use the native tier only to certify *your own* math.

`reportFromAggregate(name, version, aggregate, declaredRtp, elapsedMs)` is the
shared helper both tiers use to turn a raw `{count,sum,sumsq,min,max,hits}`
aggregate into a `WasmBatchReport`. See `examples/hold-and-win` for a worked
Zig kernel exercised through both tiers.

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
  `spinsPerMode`) **per process** so percentile and stddev can be
  computed. 100k spins ~= 800kB; `--shards N` cuts per-process memory to
  `spinsPerMode / N`. For very large single-process runs, refactor to
  streaming quantile sketches.
