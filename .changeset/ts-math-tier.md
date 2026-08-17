---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

Promote TypeScript from a prototyping convenience to the **default math tier**,
and give it the RNG seam and purity guarantees the Lua and WASM tiers already
had.

`loadTsMath(path, { rng })` joins `loadLuaMath` and `loadWasmMath`. A TS math
default-exports a **factory** (`MathFactory`) taking the host
(`MathHost = { rng_next, log_debug }`) rather than a bare math object. That
indirection is the point: Lua math draws through the `host` global and a WASM
kernel imports `host.rng_next`, so neither can reach an ambient generator, while
a bare TS module can - `Math.random()` is one identifier away, it looks correct,
and it passes every test you would think to write while silently destroying seed
reproducibility and voiding any RTP measured from a replay. A bare-object default
export is now rejected.

`loadTsMath` also runs a **purity gate** over the source before importing it,
refusing ambient randomness (`Math.random`, `crypto`), the clock (`Date`,
`performance.now`), I/O (`fetch`, `process`, `require`, dynamic `import`),
dynamic escape hatches (`globalThis`, `eval`, `Function(`), and
implementation-defined float ops (`Math.sin/cos/exp/log/pow/...`, which are not
specified to bit precision and so would not reproduce a certified RTP across
engine builds). Correctly-rounded ops stay allowed. Comments and quoted strings
are stripped before scanning; template-literal holes are not. `assertPure` is
exported so CI can gate a math file without loading it.

This is a guardrail against accidents, **not a sandbox** - a determined author
evades a source scan, and an imported module runs with the host's full authority.
Math you do not control still belongs in the WASM tier.

Measured on identical math (`examples/twin-slot`, now the same game written
three ways, with a CI-gated three-way parity test proving byte-identical
outcomes from the same RNG stream):

| Tier | per `play()` | spins / sec / core |
|------|-------------:|-------------------:|
| Lua (wasmoon) | 16,643 ns | 60,084 |
| Zig -> WASM | 1,176 ns | 850,016 |
| TS (in-process) | 13 ns | 77,978,628 |

~1,300x the Lua tier and ~92x the WASM kernel. The spread is the boundary, not
the language - in-process TS crosses nothing. It changes nothing about serving
(compute is rounding error against the wallet RPC) and everything about
simulation: a 1M-spin tuning run goes from 17 seconds to 13 milliseconds.
