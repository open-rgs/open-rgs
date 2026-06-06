# twin-slot — one simple-round slot, in Lua *and* Zig

The same slot math written twice — once in Lua (`maths/slot.lua`), once in Zig
compiled to WASM (`maths/slot.zig` → `maths/slot.wasm`) — with a test that proves
the two produce **identical outcomes** for the same RNG stream.

Why a pair? Because open-rgs treats both runtimes the same: a math is a math. Lua
is the quick, expressive way to write and iterate; the Zig/WASM twin is the fast
way to run it (no per-draw JS↔VM crossing) and a hashable artifact a regulator
can certify. This is your side-by-side template for porting between them.

## The game

One RNG draw → a paytable. RTP = **0.96**:

| draw `r`   | multiplier | probability |
|------------|-----------:|------------:|
| `r < 0.02` |       ×20  |       0.02  |
| `r < 0.06` |        ×5  |       0.04  |
| `r < 0.42` |        ×1  |       0.36  |
| otherwise  |        ×0  |       0.58  |

`0.02·20 + 0.04·5 + 0.36·1 = 0.96`. The Lua `if/elseif` ladder and the Zig
`decide()` use the **same thresholds and payouts** and draw exactly once — keep
them in lock-step or the parity test fails. That test *is* the contract between
the two files.

## Files

| File | What |
|---|---|
| `maths/slot.lua` | the slot in Lua — the readable reference |
| `maths/slot.zig` | the same slot in Zig (+ an in-WASM `sim_batch` for RTP) |
| `maths/slot.wasm` | committed build of `slot.zig` (CI uses it; no zig needed) |
| `src/compare.ts` | runnable demo: the same stream through both, side by side |
| `test/twin-slot.test.ts` | CI proof — 20k-spin parity + measured RTP |

## Run

```bash
bun test examples/twin-slot            # parity + RTP
bun examples/twin-slot/src/compare.ts  # watch them agree, spin by spin
```

## Rebuild the WASM (only if you change `slot.zig`)

```bash
cd examples/twin-slot/maths
zig build-exe slot.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=slot.wasm
```

## See also

- `examples/twin-gamble` — the same idea for a **complex** (multi-step) round.
- `examples/hello-spin` — a Lua simple slot wired into a runnable server.
- `packages/core/test/fixtures/wasm` — the reference WASM ABI kernels.
