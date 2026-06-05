---
"@open-rgs/core": minor
---

feat(core): `loadWasmMath` — WASM math kernels (simple), ~15× faster than Lua

New `loadWasmMath(path, opts)` loads a `.wasm` math kernel conforming to the spec ABI (specs/03-math-runtime.md) and adapts it to `MathModule` — the orchestrator can't tell it from a Lua math. A WASM kernel runs **~15× faster than the equivalent Lua math** (measured, 1-draw distribution): it calls the `host.rng_next` import directly with no per-draw JS↔WASM proxy tax, stays **sandboxed by construction**, and ships as a **hashable artifact** for certification. I/O is MessagePack over linear memory; RNG resolution is shared with `loadLuaMath` (secure system CSPRNG by default, fail-closed in production). A reference Zig kernel and the built `.wasm` are in the core test fixtures.

Scope: **simple** math (single `play`). Complex (`open`/`step`/`close`/`is_terminal`) is planned — it needs in-kernel msgpack-decode of state — and currently throws a clear error. Internal: the Lua→TS outcome adapters were extracted to a shared `math-adapt` module so both loaders normalise outcomes identically, and `resolveRng` is shared so the WASM loader inherits the exact secure-default / fail-closed policy.
