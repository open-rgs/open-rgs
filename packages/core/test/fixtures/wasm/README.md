# Reference WASM/native math kernel

One math, three artifacts, **one source of truth** (`kernel.zig`):

| File | Built with | Used by |
|---|---|---|
| `kernel.zig` | — | shared `decide` (the distribution) + xoshiro256++ PRNG + `Stats` |
| `play.zig` → `play.wasm` | `zig` → `wasm32` | `loadWasmMath` (`play`) **and** the in-WASM batch sim (`sim_batch`) |
| `sim.zig` → `sim` | `zig` → native | the native multithreaded simulator (`simulateNativeBatch`) |

Because `play.wasm` and `sim` both compile `kernel.zig`, the native simulator
measures **byte-identically** what the WASM you serve produces — verified by the
parity test (`packages/simulator/test/native-parity.test.ts`).

## Build

```bash
# WASM kernel (committed as play.wasm; CI uses the committed artifact, no zig)
zig build-exe play.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=play.wasm

# Native simulator (NOT committed — platform-specific; build your own)
zig build-exe sim.zig -OReleaseFast -femit-bin=sim
```

## Run the native sim

```bash
./sim <spins> <seedHi> <seedLo> <threads>
# e.g. 100M spins on 10 threads:
./sim 100000000 42 0 10
# -> {"count":1e8,"sum":...,"hits":...,"threads":10,"elapsedMs":60.6}  (~1.65B spins/sec)
```

`threads=1` runs a single slice seeded by `(seedHi,seedLo)` — exactly
`sim_batch(spins, seedHi, seedLo)` in WASM, which is what the parity test
compares.

## Security note

`play.wasm` is sandboxed (served + simulated safely). The native `sim` binary is
**not** sandboxed and is a **separate build**, so it is only sound for
certification while the **parity test passes** — run it whenever you change
`kernel.zig`. Use the native tier for offline certification of your own math.
