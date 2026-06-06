# twin-gamble — one complex-round game, in Lua *and* Zig

A minimal **complex round** — a multi-step `open → step* → close` state machine —
written twice, in Lua (`maths/gamble.lua`) and Zig/WASM (`maths/gamble.zig`), with
a test that drives full lifecycles through both and proves they're **1:1**.

If [twin-slot](../twin-slot) shows the simple case, this shows how a *stateful,
interactive* round works in each runtime — and how the engine threads an opaque
`state` blob back into every call so the math itself stays stateless.

## The mechanic — fair double-or-nothing

- **`open()`** deals a base win from a paytable and, if `win > 0`, awaits a decision.
- **`step()`** is one **fair** gamble: heads (p=0.5) doubles the win, tails busts to 0.
- **`close()`** pays the current win. To **collect**, the player just closes instead
  of stepping again (collect = the `closeRound` request, not an action).

Base paytable, RTP **0.96**: `r < 0.18 → 2`, `r < 0.78 → 1`, else `0`
(`0.18·2 + 0.60·1 = 0.96`). Up to 8 gambles → max **512×** the base win.

### Why it's worth studying

A fair gamble is **EV-neutral**, so the round's RTP equals the base slot's (~0.96)
under *any* gamble policy — gambling moves **variance**, not edge. The in-WASM
`sim_gamble` self-play proves it: RTP stays flat (`stop@0..3` ≈ 0.96) while the
max win grows `2 → 16 → 512`. Deep gambles are EV-neutral too, by construction,
but so high-variance that a tight Monte-Carlo RTP check would be flaky — so the
test asserts the flat edge where it converges and the growing variance throughout,
rather than a number it can't actually pin down.

It also fits open-rgs's money model exactly: one bet at open, payout at close,
multiplier ≥ 0 — you only ever risk the *won* amount, never a second wager.
(Contrast `examples/cash-ladder`, whose climb is *unfair* and erodes RTP, and
`examples/gamble-slot`, a TS deep-dive into gamble *policies* and play-flow charts.)

## The 1:1 trick

Both `step()`s **ignore the action payload**: the only step is `"gamble"` and the
engine already validated `action.type`, while collecting is a separate
`closeRound`. That's what keeps the Lua and Zig kernels trivially identical — no
msgpack action-decoding in Zig. The opaque `state` *encoding* differs per runtime
(Lua: a `"gambles,done,win"` string; Zig: an 8-byte blob the host base64s) — only
the **outcomes** must match, and they do, step for step.

## Files

| File | What |
|---|---|
| `maths/gamble.lua` | the round in Lua — the readable reference |
| `maths/gamble.zig` | the same round in Zig (+ an in-WASM `sim_gamble` self-play) |
| `maths/gamble.wasm` | committed build of `gamble.zig` (CI uses it; no zig needed) |
| `src/round.ts` | runnable demo: one round through both, step by step |
| `test/twin-gamble.test.ts` | CI proof — lifecycle parity + fair-gamble RTP |

## Run

```bash
bun test examples/twin-gamble          # parity + fair-gamble RTP + lifecycle
bun examples/twin-gamble/src/round.ts  # watch one round play out in both
```

## Rebuild the WASM (only if you change `gamble.zig`)

```bash
cd examples/twin-gamble/maths
zig build-exe gamble.zig -target wasm32-freestanding -fno-entry -rdynamic \
  -OReleaseSmall -femit-bin=gamble.wasm
```

## See also

- `examples/twin-slot` — the same idea for a **simple** (single-call) round.
- `examples/cash-ladder` — a complex Zig round with an *unfair* climb (RTP erodes).
- `specs/03-math-runtime.md` — the complex-round ABI (open/step/is_terminal/close).
