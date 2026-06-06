# @open-rgs/simulator

## 1.2.0

### Minor Changes

- [#27](https://github.com/open-rgs/open-rgs/pull/27) [`8b46c12`](https://github.com/open-rgs/open-rgs/commit/8b46c124cdde3c73d69423e28c59fe487cb88ee5) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(simulator): native multithreaded simulator (extreme tier), ~1.65B spins/sec

  `simulateNativeBatch(binPath, opts)` drives a standalone native sim binary — built from the **same `kernel.zig`** as the WASM you ship, parallelised with `std.Thread` (rayon is Rust; this is the Zig equivalent) — and returns the same focused RTP report as `simulateWasmBatch`. **Measured ~1.65B spins/sec: 100M spins in ~60ms on 10 threads** — the fastest path.

  Soundness rests on a **byte-parity test**: a native single slice is byte-identical to WASM `sim_batch` for the same seed (shared kernel source, both IEEE-754 f64). The test builds the binary with zig and is **skipped where zig is absent** (e.g. CI), so it never blocks the suite. The native binary is **not sandboxed** and is a **separate build** from the served WASM — use it for offline certification of your own math only, and re-run the parity test whenever the kernel changes.

  Also exports `reportFromAggregate` (+ `BatchAggregate`), shared by both batch simulators. The reference kernel is split into `kernel.zig` (shared `decide` + PRNG + stats), `play.zig` (→ `play.wasm`: `play` + `sim_batch`), and `sim.zig` (→ native binary); the WASM `play`/`sim_batch` behaviour is unchanged.

- [#37](https://github.com/open-rgs/open-rgs/pull/37) [`69b4328`](https://github.com/open-rgs/open-rgs/commit/69b43280e0bce4c4061fa53ffc2089b49a217f0e) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(simulator): play-flow graph - SEE how interactive rounds were played

  A single RTP number says how much, not how. `simulate({ flow })` now records a
  **play-flow graph**: a little Markov chain of how complex rounds were actually
  played - decision nodes, the action taken, and the transition probability. It's
  attached to `report.flow` and rendered by `mdReport` as a **Mermaid flowchart**
  (reads like a Markov chain; renders inline on GitHub and the docs site) plus a
  transition table.

  Pass `flow: true` to label nodes by `awaiting.type`, or `flow: { label }` to
  bucket nodes from the PUBLIC context (`awaiting` + `ops`) - never the opaque
  state, so the view can't depend on hidden info. Off by default (zero overhead).

  New exports: `createFlowRecorder`, `flowToMermaid`, `flowToMarkovTable`,
  `FlowGraph`, `FlowEdge`, `FlowContext`, `FlowLabel`. The goal: make interactive
  (complex / options) game math easy to eyeball and test - run it, look at the
  chart, check the transitions match intent. See `examples/gamble-slot` (the
  gamble-or-collect ladder visualized as a Markov chain).

- [#35](https://github.com/open-rgs/open-rgs/pull/35) [`d5b57c4`](https://github.com/open-rgs/open-rgs/commit/d5b57c4e47ca07b7ac031a6575c2edbe654b13eb) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(simulator): pluggable complex-round strategy (policy function)

  `simulate({ complexStrategy })` accepted only `"first"` / `"random"`. It now also
  takes a **policy function** `(ctx) => PlayerAction`, where `ctx` is the public
  context at each decision - `awaiting`, the latest public `ops`, the step index,
  and the seeded rng. This is how you simulate games whose RTP depends on player
  choices: "keep gambling N times", a gamble-to-target rule, an optimal solver.

  The strategy deliberately sees only what a real client sees (`awaiting` + `ops`),
  never the opaque round `state`, so simulated policies can't cheat on hidden info.

  Exports: `StrategyFn`, `StrategyContext`, `ComplexStrategy`. The built-in
  `"first"` / `"random"` names are unchanged. (A complementary in-kernel self-play
  tier - a fixed policy baked into the WASM kernel for ~native-speed policy sweeps -
  is shown in `examples/cash-ladder` via its `sim_ladder` export.)

- [#26](https://github.com/open-rgs/open-rgs/pull/26) [`f5bc306`](https://github.com/open-rgs/open-rgs/commit/f5bc306b7e81347bab128795e586aabd81dda273) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(simulator): `simulateWasmBatch` — in-WASM batch simulation, ~216M spins/sec

  `simulateWasmBatch(wasmPath, opts)` runs the entire spin loop **inside** a WASM math kernel — via a `sim_batch` export (a seeded in-VM xoshiro256++ plus the same `decide` logic the kernel's `play` uses) — so there is no per-spin JS↔WASM boundary, only one crossing per chunk. **Measured ~216M spins/sec single-threaded (100M spins in ~0.46s)**, roughly 250× the per-spin WASM path. It's the **same sandboxed artifact you serve** — the batch measures the production `play` logic by construction, so there's nothing to re-certify.

  Returns a focused RTP-certification report: measured RTP + 95% CI + verdict, hit rate, and the multiplier mean / stdDev / min / max — all **exact** from the kernel's `(count, sum, sumsq, min, max, hits)` aggregate. Distribution percentiles and outcome-type / mark breakdowns are not produced by the fast path (use the per-spin simulator for those). Each chunk draws an independent substream; results are deterministic per seed. Pair with `--shards` for multicore. (The reference kernel in the core test fixtures gains the `decide` + `sim_batch` exports.)

## 1.1.0

### Minor Changes

- [#19](https://github.com/open-rgs/open-rgs/pull/19) [`52e39ec`](https://github.com/open-rgs/open-rgs/commit/52e39ec80803c9c5110071c8dcbd8a86c667869b) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(simulator): shard big runs across cores with `--shards N`

  `open-rgs-sim --shards N` splits a run across N independently-seeded worker processes (one per core) and merges the per-shard reports — near-linear speedup for large certification runs. The merge (new exported `mergeReports`) is **exact** for the cert-critical numbers: measured RTP, standard error, 95% CI, verdict, hit rate, outcome-type/next-mode counts, RTP contributions, deviations, and the multiplier mean / stdDev (pooled population variance) / min / max. Only the distribution percentiles (multiplier + observation p50..p99) are count-weighted across shards and flagged via a new optional `SimulationReport.sharded` field. Sharding requires the manifest module to export a factory `({ seed }) => GameManifest` so each shard draws an independent RNG substream; a static manifest is refused (it would replay the identical stream — a fail-closed safeguard against an over-confident result).

## 1.0.1

### Patch Changes

- Updated dependencies [[`a414783`](https://github.com/open-rgs/open-rgs/commit/a41478386a0f2ba44dbf632405f73be0d0e105bc), [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc)]:
  - @open-rgs/contract@1.1.0

## 1.0.0

### Major Changes

- [#72](https://github.com/open-rgs/open-rgs/pull/72) [`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - open-rgs 1.0.0 - first stable release.

  This release follows a full production-readiness audit; every Critical, High, Medium, and Low finding has been resolved. Highlights:

  - **Money math** is integer minor units end to end, rounded half-to-even at the single settle boundary, with safe-integer guards that fail loud instead of silently corrupting past 2^53 (ADR-002).
  - **Fairness & isolation**: RNG is injected and fail-closed in production; the Lua math runtime is sandboxed (denylisted globals, host-routed `math.random`) with an instruction-budget execution watchdog.
  - **Integrity**: stable per-round idempotency keys, per-session serialization, and a hash-chained tamper-evident audit log.
  - **Operations**: authenticated and network-isolatable admin surface, accurate `/healthz` versioning, frame-size limits, and value-level log redaction.
  - **Adapter contract**: the autoclose backstop is a hard conformance requirement and the conformance suite proves real idempotency/error-path safety.

  The public surface (`@open-rgs/contract` + `@open-rgs/core`) is now considered stable under semver. All eight `@open-rgs/*` packages move to 1.0.0 together for this milestone; subsequent releases version independently.

### Patch Changes

- Updated dependencies [[`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29)]:
  - @open-rgs/contract@1.0.0
