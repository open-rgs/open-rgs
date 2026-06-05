---
"@open-rgs/core": minor
---

perf(core): Lua-native `host` table (~3–5× on RNG-heavy math) + opt-in `rngMode: "seed-expand"`

The math `host` was a JS-backed object, so every `host.rng_next()` — read once per draw — crossed the JS↔WASM boundary through the proxy's `__index` (~4.3 µs/access, measured), dominating draw-heavy math. `host` is now built as a pure Lua table that references the JS hooks, making `host.rng_next` a cheap Lua index. Measured **~3.1× (10 draws/spin) to ~5.3× (50 draws/spin)** faster on the RNG hot path — by default, with no behaviour or certification change (the same injected `rng` still determines outcomes).

New opt-in `loadLuaMath({ rngMode: "seed-expand" })`: draws one seed per math call from the injected `rng` and expands it in-VM with **xoshiro256++** (multiply-free; bit-verified against a reference; uniform), so the math draws with zero per-draw crossings — a further win for draw-heavy math (**~9.2× vs the old default at 50 draws/spin**). Each call is reseeded independently and the generator is hidden from the (untrusted) math. CERT NOTE: under `"seed-expand"` the expansion enters the outcome-determination path and must be evaluated as part of the RNG; the default stays `"per-draw"` (unchanged).
