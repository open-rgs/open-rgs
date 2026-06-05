---
"@open-rgs/simulator": minor
---

feat(simulator): `simulateWasmBatch` — in-WASM batch simulation, ~216M spins/sec

`simulateWasmBatch(wasmPath, opts)` runs the entire spin loop **inside** a WASM math kernel — via a `sim_batch` export (a seeded in-VM xoshiro256++ plus the same `decide` logic the kernel's `play` uses) — so there is no per-spin JS↔WASM boundary, only one crossing per chunk. **Measured ~216M spins/sec single-threaded (100M spins in ~0.46s)**, roughly 250× the per-spin WASM path. It's the **same sandboxed artifact you serve** — the batch measures the production `play` logic by construction, so there's nothing to re-certify.

Returns a focused RTP-certification report: measured RTP + 95% CI + verdict, hit rate, and the multiplier mean / stdDev / min / max — all **exact** from the kernel's `(count, sum, sumsq, min, max, hits)` aggregate. Distribution percentiles and outcome-type / mark breakdowns are not produced by the fast path (use the per-spin simulator for those). Each chunk draws an independent substream; results are deterministic per seed. Pair with `--shards` for multicore. (The reference kernel in the core test fixtures gains the `decide` + `sim_batch` exports.)
