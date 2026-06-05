---
"@open-rgs/core": minor
---

feat(core): default the math RNG to the system CSPRNG (`cryptoRng`), never `Math.random`

`loadLuaMath` now defaults to `cryptoRng` — a new exported helper backed by the system CSPRNG via WebCrypto (`getRandomValues` → BoringSSL/OpenSSL, the same source Bun's `crypto` uses), returning a uniform 53-bit float in `[0,1)`. Outcome randomness is therefore cryptographically secure by default, and `Math.random` (V8 xorshift128+, non-crypto, unseedable) is never used to determine outcomes — previously it was the dev/no-rng fallback.

Production still **fails closed** when no `rng` is injected (Guarantee 5 intact), so operators choose their source consciously: pass `{ rng: cryptoRng }` for the system CSPRNG, or inject a jurisdiction-certified (auditable, seed-commit) source. `cryptoRng` is exported from `@open-rgs/core`.
