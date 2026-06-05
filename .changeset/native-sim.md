---
"@open-rgs/simulator": minor
---

feat(simulator): native multithreaded simulator (extreme tier), ~1.65B spins/sec

`simulateNativeBatch(binPath, opts)` drives a standalone native sim binary — built from the **same `kernel.zig`** as the WASM you ship, parallelised with `std.Thread` (rayon is Rust; this is the Zig equivalent) — and returns the same focused RTP report as `simulateWasmBatch`. **Measured ~1.65B spins/sec: 100M spins in ~60ms on 10 threads** — the fastest path.

Soundness rests on a **byte-parity test**: a native single slice is byte-identical to WASM `sim_batch` for the same seed (shared kernel source, both IEEE-754 f64). The test builds the binary with zig and is **skipped where zig is absent** (e.g. CI), so it never blocks the suite. The native binary is **not sandboxed** and is a **separate build** from the served WASM — use it for offline certification of your own math only, and re-run the parity test whenever the kernel changes.

Also exports `reportFromAggregate` (+ `BatchAggregate`), shared by both batch simulators. The reference kernel is split into `kernel.zig` (shared `decide` + PRNG + stats), `play.zig` (→ `play.wasm`: `play` + `sim_batch`), and `sim.zig` (→ native binary); the WASM `play`/`sim_batch` behaviour is unchanged.
