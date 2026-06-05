---
"@open-rgs/core": minor
---

feat(core): `createMathPool` — run WASM math in a worker pool with a hard per-call timeout

`createMathPool({ wasmPath, size, timeoutMs })` runs a WASM math kernel across a pool of Worker threads, off the orchestrator's I/O thread, and returns a `SimpleMath`-shaped async math (plus `shutdown()`). Two wins:

- **Performance:** math executes on worker threads → concurrency under load; a single spin never blocks the event loop.
- **Security (Guarantee 5, fail-closed / no-DoS):** a running WASM call can't be interrupted from JS, so a runaway kernel is killed via `worker.terminate()` on timeout and the worker is replaced — the watchdog the bare `loadWasmMath` path lacks. Verified: a `play()` that loops forever rejects with `MATH_TIMEOUT` at the budget and the pool recovers for the next call.

Each worker loads the kernel with a worker-local secure RNG (`cryptoRng`). v1 covers simple (single `play`) WASM math; complex (`open`/`step`/`close`) and a Lua-in-pool path are follow-ups.
