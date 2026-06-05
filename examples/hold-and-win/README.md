# Example: hold-&-win math in Zig

A **generic** hold-&-win slot, written in Zig and compiled to WASM. The numbers
here are **invented** to demonstrate the runtime — not taken from any specific
commercial game.

## The mechanic

A 3×3 grid. In the base game, coin symbols can land in each cell. If **6 or
more** coins land, the **hold-&-win feature** starts:

- the coins lock and you get **3 respins**;
- every respin that lands **at least one new coin resets the respins to 3**;
- the feature ends when a respin lands no new coins, or when the grid is full;
- **filling all 9 cells** awards the **grand** jackpot.

Each coin carries a credit value (1/2/5/10/25/100/500×), and the round win is
the sum of locked coins (capped at 5000×). Tuned to **RTP ≈ 96%**.

## Three artifacts, one source

| file | built with | role |
|---|---|---|
| `maths/kernel.zig` | — | the math: PRNG + `playRound` (generic over the RNG) + `Stats` |
| `maths/play.zig` → `maths/play.wasm` | `zig` → wasm32 | served game (`play`, host CSPRNG) **and** fast batch sim (`sim_batch`) |
| `maths/sim.zig` → `sim` | `zig` → native | native multithreaded simulator (build your own; gitignored) |

`play.wasm` is committed so the simulator/CI need no zig. Because `play.wasm`
and `sim` both compile `kernel.zig`, the native simulator is **byte-identical**
to the served WASM (see the parity test in `@open-rgs/simulator`).

## Run

```bash
# Fast in-WASM batch sim (sandboxed; the committed artifact):
bun run examples/hold-and-win/src/sim.ts 50000000      # 50M spins

# Build + run the native multithreaded sim (needs zig):
cd examples/hold-and-win/maths
zig build-exe sim.zig -OReleaseFast -femit-bin=sim
./sim 1000000000 10                                    # 1B spins, 10 threads

# Build the served WASM from source (else use the committed play.wasm):
zig build-exe play.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=play.wasm
```

## Measured (this machine, 10 cores)

- in-WASM batch: ~**200M spins/sec** (sandboxed)
- native + threads: **1B spins in ~5s (~200M/s)** — heavier per-spin than a
  one-draw slot (15+ draws + the respin loop)
- RTP **95.9%**, hit **30.7%**, feature **1 in 100**, grand **1 in ~12,500**,
  max **1541×**
