# Example: complex round in Zig (cash-ladder)

A **complex round** (`open → step* → close`) written as a Zig WASM kernel. It
shows the thing that makes complex math interesting: **serialized state**, plus
ops and awaiting hints, all crossing the JS↔WASM boundary as MessagePack.

The mechanic is a gamble ladder: you start at `1.00x`; each `climb` either busts
(25% chance, pays 0) or grows the multiplier `×1.28`; you cash out by closing
before you bust. (Just one example — more complex games live in the
[open-rgs-examples](https://github.com/open-rgs/open-rgs-examples) gallery.)

## The key idea: the kernel keeps nothing

Core stores the round's `state` (an opaque string) and threads it back into the
next `step` / `is_terminal` / `close`. So the kernel must **serialize the whole
round state on every call and rehydrate it on the next** — it holds no globals
between calls. That is exactly why a round survives a reconnect or a server
restart, and why one reused wasm instance can interleave many concurrent rounds.

```
open(prev, ctx)      -> { state, ops, awaiting? }
step(state, action)  -> { state, ops, awaiting? }   // awaiting=null => ready to close
is_terminal(state)   -> bool
close(state)         -> { multiplier, ops, type }
autoclose(state)     -> close-shaped   // external trigger only (wallet/admin)
```

## The state boundary (bytes ↔ string)

`RoundState` is an opaque **string** in the contract, but the kernel's state is
**bytes**. The loader owns the bridge: the kernel emits `state` as a MessagePack
`bin`; `loadWasmMath` **base64**s it into the `RoundState` string and base64-
decodes it back before the next call. The kernel never sees base64; core never
sees bytes. (See `maths/play.zig` — an 8-byte `State` struct it packs/unpacks
itself.) `ops` are opaque and forwarded to the client verbatim.

## Files

| File | | What |
|------|---|------|
| `maths/play.zig` | — | the kernel: `State` (de)serialize + open/step/close/is_terminal/autoclose |
| `maths/play.zig` → `maths/play.wasm` | `zig` → wasm32 | the served, hashable artifact (committed so CI needs no zig) |

## Run

```bash
# Play a full round (open -> climb* -> close), printing the lifecycle:
bun examples/cash-ladder/src/round.ts

# Build the kernel from source (else use the committed play.wasm):
cd examples/cash-ladder/maths
zig build-exe play.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=play.wasm
```

## Wire it into a game

```ts
import { loadWasmMath, cryptoRng } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";

const math = await loadWasmMath("./maths/play.wasm", { rng: cryptoRng });
const manifest = defineGame({
  id: "cash-ladder", declaredRtp: 0.96, defaultMode: "default",
  modes: { default: { math, stakeMultiplier: 1 } },
});
```

> ⚠️ `loadWasmMath` has **no execution watchdog**, and the worker pool
> (`createMathPool`) is simple-only today — so a complex kernel has no
> fail-closed timeout yet. Keep complex WASM kernels **trusted and bounded**.
> See `specs/03-math-runtime.md`.
