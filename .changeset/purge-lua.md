---
"@open-rgs/contract": major
"@open-rgs/core": major
---

**Remove the Lua math tier.** `loadLuaMath`, `LuaExtension`, `LuaVm` and the
`wasmoon` dependency are gone. Two tiers remain:

- **TS** (`loadTsMath`) - you wrote the math and you run the server. Default.
- **WASM** (`loadWasmMath`) - someone else wrote it, or you need bit-deterministic
  floats and a hashable artifact for a lab.

Lua sat in an awkward middle and lost to WASM on every axis it was supposed to
win. Sandboxed: WASM is too, and by construction. Certifiable: WASM ships a
hashable artifact and bit-deterministic float ops; Lua does neither. Hot reload:
`loadTsMath` cache-busts on content hash. And it was ~1,300x slower than the TS
tier on identical math, which mattered not for serving - compute is rounding
error against the wallet RPC - but for the tune loop a math author actually
lives in.

Removing it also deletes the `LuaExtension` plugin system entirely. That
mechanism only existed because Lua math cannot `import`: it needed a
registration contract, a prelude source transform, host bridging, and a rule
that every extension be self-contained (nested tables marshal unreliably across
the bridge). TS math just imports, so a library is an ordinary package.
`@open-rgs/ext-reels` and `@open-rgs/ext-holdwin` are deprecated with it.

**Migrating.** A Lua math is a near-mechanical transliteration - the twin-slot
port was 20 lines. The one shape change is that a TS math default-exports a
FACTORY taking the host rather than a bare object:

```ts
export default (host: MathHost): SimpleMath => ({
  kind: "simple", name: "spin", version: "1.0.0", rtp: 0.96,
  play: () => { const r = host.rng_next(); /* ... */ },
});
```

That indirection is the RNG seam Lua got from its `host` global, and
`loadTsMath` rejects a bare-object export for exactly that reason.

`cryptoRng` and `resolveRng` moved from the Lua loader into `core/src/rng.ts`
and are still exported from `@open-rgs/core`.
