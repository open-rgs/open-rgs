---
"@open-rgs/core": minor
---

feat(core): complex WASM math (open/step/close) in loadWasmMath

`loadWasmMath` now supports **complex** kernels (`kind=1`) - `open` / `step` /
`is_terminal` / `close` plus optional `autoclose` - not just simple `play`.

The loader owns the state boundary: a complex round's `state` is an opaque
*string* in the contract, but a kernel's state is bytes, so the kernel emits
`state` as a MessagePack `bin` and the loader base64-encodes it into the
`RoundState` string (and decodes it back before the next call). The kernel stays
binary-native; core sees an opaque string it threads across calls.

Worked Zig example in `examples/cash-ladder`; ABI pinned in
`specs/03-math-runtime.md`. Note: `createMathPool` is still simple-only, so a
complex WASM kernel has no fail-closed execution timeout yet - keep complex
kernels trusted and bounded.
