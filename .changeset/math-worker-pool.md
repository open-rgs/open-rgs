---
"@open-rgs/core": minor
---

feat(core): `createMathPool` — run WASM math in a worker pool, off the I/O thread

`createMathPool({ wasmPath, size, timeoutMs })` runs a WASM math kernel across a pool of Worker threads, off the orchestrator's I/O thread, and returns a `SimpleMath`-shaped async math (plus `shutdown()`).

- **Performance:** math executes on worker threads → concurrency under load; a single spin never blocks the event loop.
- **Round-level fail-closed:** a call that overruns its `timeoutMs` budget rejects with `MATH_TIMEOUT` (the round refuses to pay a hung/overrunning value, and the connection isn't left waiting) and the worker is replaced, so the pool stays usable.

**Not a portable no-DoS sandbox.** Failing the round closed is the portable guarantee; the worker is also `terminate()`d, but whether terminate() kills a tight synchronous runaway (`while(true){}`) is platform-dependent — in our testing it did on Linux, did not on Bun+macOS — so on some platforms a runaway thread can leak (keep a core busy). Treat WASM kernels as **trusted and bounded** (same posture as bare `loadWasmMath`); the pool buys off-thread concurrency + round-level failure. A hard, cross-platform no-DoS kill needs process isolation (SIGKILL) — a follow-up. (Only the Lua loader's in-VM `debug.sethook` watchdog preempts a tight loop on any platform.)

Each worker loads the kernel with a worker-local secure RNG (`cryptoRng`). v1 covers simple (single `play`) WASM math; complex (`open`/`step`/`close`) and a process-isolated no-DoS pool are follow-ups.
