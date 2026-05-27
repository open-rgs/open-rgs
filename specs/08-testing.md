# Spec 08  - Testing & Certification

## Goal

Define the test surface for the orchestrator, the math runtime, and
individual math files. Specify the simulator/fuzzer/optimizer CLI
that math designers and labs use.

## Layers

| Layer | What it tests | Tool |
|-------|---------------|------|
| Math unit | RTP, hit rate, volatility, mode mix per math file | `@open-rgs/cli simulate` |
| Math exploit | Are there strategies that beat declared RTP? | `@open-rgs/cli compare`, `fuzz` |
| Math tuning | Find parameter values that hit target RTP+vol | `@open-rgs/cli optimize` |
| Math certification | Signed report comparing measured vs declared | `@open-rgs/cli certify` |
| Orchestrator unit | Round flows, mode resolution, FRC, autoclose | `bun:test` against `OrchestratorAPI` |
| Platform adapter | Native protocol -> canonical contract | per-adapter test suite |
| Transport | Frame in / frame out | `bun:test` with mock orchestrator |
| End-to-end | Full stack with real wallet (mock) | `bun:test` integration |

## Math unit tests

Goal: assert measured RTP per mode converges to declared RTP within
epsilon over N spins.

```bash
@open-rgs/cli simulate ./examples/lucky-digits/manifest.ts \
    --mode default --spins 10M --seed 42

# output:
# Game: example-game  Mode: default  Math: lucky-digits-base 1.0.0
# Spins: 10,000,000
# Measured RTP: 0.9097 (declared 0.91  - within 0.5%)
# Hit rate: 0.252
# Volatility (std dev / mean): 18.4
# Max win observed: 50x bet
# Histogram: ...
```

Each game ships a `tests/rtp.test.ts` (or equivalent) that runs
`simulate` programmatically and asserts RTP is within tolerance. Run
in CI on every commit that touches `maths/`.

## Strategy testing for complex rounds

For complex maths, the simulator can't drive itself  - it needs
strategies (action pickers). Math files ship a `simulate.pickAction`
function or the game ships separate strategy files in `strategies/`:

```lua
-- strategies/blackjack/basic.lua
return function(public_state, awaiting, history)
  if awaiting.type == "hit_or_stand" then
    local total = hand_total(public_state.player_hand)
    return total < 17 and { type = "hit" } or { type = "stand" }
  end
end
```

```bash
@open-rgs/cli simulate ./blackjack/manifest.ts \
    --strategy ./strategies/blackjack/basic.lua \
    --spins 1M
```

## Exploit testing

`compare` runs the same math against multiple strategies in parallel
and surfaces any strategy that beats declared RTP by more than eps.

```bash
@open-rgs/cli compare ./examples/blackjack/manifest.ts \
    --strategies basic,greedy,always-hit,random \
    --spins 1M

# output:
# Strategy        Measured RTP   delta from declared
# basic-strategy   0.9943         -0.07%
# greedy           0.8821         -11.79%
# always-hit       0.6512         -34.88%
# random           0.7811         -22.0%
# 
# All strategies underperform declared RTP. ✓
```

`fuzz` generates random strategies (random decision trees) and looks
for unexpected winners:

```bash
@open-rgs/cli fuzz ./examples/blackjack/manifest.ts \
    --target-rtp 0.995 --tolerance 0.005 --budget 1000

# Generated 1000 random strategies, 1M spins each.
# 0 strategies beat target by more than tolerance. ✓
```

CI runs `fuzz` with a small budget on every commit (smoke), and a
nightly job runs it with a large budget (deep).

## Public vs private state

For exploit testing to be meaningful, math files MUST expose only
public state (what a player can see) to strategies. The current
contract doesn't enforce this  - `RoundState` is opaque to core, but a
strategy receives the full state.

Planned addition to `ComplexMath`:

```ts
view(state: RoundState): unknown   // optional projection
```

When defined, the simulator hands `view(state)` to strategies instead
of the raw state. Math without `view()` is acceptable for simple-round
games (no per-step decisions) and games where all state is public.

## Optimizer

`optimize` searches the math's declared parameter space for values
that hit target metrics. Math declares parameters in a sibling
`parameters.json` or `M.parameters` table:

```json
{
  "reel_strip_a": { "type": "weights", "default": [70, 25, 5], "constraint": "sum-to-100" },
  "trigger_prob": { "type": "float", "default": 0.001, "min": 0, "max": 0.01 },
  "fs_count":     { "type": "int", "default": 10, "min": 5, "max": 20 }
}
```

```bash
@open-rgs/cli optimize ./examples/lucky-digits/maths/base/play.lua \
    --targets rtp=0.96,volatility=medium \
    --spins-per-eval 500K --budget 200

# Trial 1: { trigger_prob=0.001, fs_count=10 } -> RTP 0.91
# Trial 2: { trigger_prob=0.0014, fs_count=12 } -> RTP 0.93
# ...
# Best:    { trigger_prob=0.0021, fs_count=14 } -> RTP 0.9598
```

Algorithm: Bayesian optimization (default) or SPSA / CMA-ES via flag.

Multi-mode optimization composes per-mode RTP into a single loss; the
manifest's expected mode mix (e.g., 95% base, 4% buy-fs, 1% buy-mini)
is supplied as input.

## Certification reports

`certify` produces a signed JSON report a math lab can hand to a
regulator:

```json
{
  "schema": 1,
  "game": "example-game",
  "math_file": "maths/base/play.lua",
  "math_file_hash": "sha256:...",
  "lua_runtime": "wasmoon@1.16.0",
  "rng": "seed:0xABCDEF",
  "spins": 100000000,
  "declared_rtp": 0.91,
  "measured_rtp": 0.9097,
  "delta": -0.000297,
  "tolerance": 0.005,
  "passed": true,
  "histogram": { "0": 73000000, "2": ..., ... },
  "max_win_x": 50,
  "max_win_freq": 1.2e-7,
  "generated_at": "2026-05-06T20:00:00Z",
  "signature": "..."
}
```

Signing is out of scope for the open-source CLI but the report shape
is regulator-friendly and signable by any tool.

## Orchestrator unit tests

Drive `OrchestratorAPI` directly with `MockPlatform`. Examples of what
the test suite covers:

- INIT with no FRC -> no `frc` field on response.
- INIT with FRC -> `frc` field populated, marked offered on session.
- SPIN with insufficient balance -> `INSUFFICIENT_BALANCE`, no wallet
  call.
- SPIN with active FRC -> bet locked to campaign's bet, mode forced to
  default.
- Math returns `nextMode: "free-spins"` -> next SPIN routes there even
  if client requests `default`.
- OPEN_ROUND while another is open -> `ROUND_ALREADY_OPEN`.
- STEP with mismatched action.type -> `INVALID_ACTION` without invoking
  math.
- STEP loop until terminal, then CLOSE -> settles correctly.
- Disconnect mid-round -> session retained; reconnect INIT carries
  `resume` payload with full action history.
- Wallet emits `autocloseRequested` -> math.autoclose runs, wallet
  closeComplex called, round dropped.
- Wallet emits `sessionClosed` with open round -> autoclose first, then
  drop.

## Transport tests

Drive `binaryTransport` with a mock `OrchestratorAPI` and assert frame
encode/decode roundtrips. Example assertions:

- `0x03` + valid msgpack -> `orchestrator.spin()` called with correct
  decoded payload.
- `orchestrator.spin()` returns -> `0x04` frame with msgpack-encoded
  response.
- `0xff` error frame on `RGSError` from orchestrator.
- Text frame -> `INVALID_FORMAT` immediate response.
- Empty frame -> `INVALID_FORMAT`.
- Unknown type byte -> `DECODE_ERROR`.

## Acceptance criteria

- `@open-rgs/cli simulate ./examples/lucky-digits/manifest.ts --mode default --spins 1M`
  completes in under 60 seconds on a single core and reports RTP within
  0.005 of the declared value.
- `@open-rgs/cli fuzz ./examples/blackjack/manifest.ts --budget 100`
  completes and finds zero exploits (assuming the math is clean).
- The orchestrator unit-test suite covers >= 80% of branches in
  `orchestrator.ts` (planned, not yet measured).

## Open questions

- Should the simulator support distributed runs (sharded across
  machines for billion-spin certification)? **Yes long-term**; v1
  single-process.
- Should the optimizer backend be pluggable (Bayesian / SPSA / GA)?
  **Yes**; ship one default, accept PRs for others.
- Should `certify` output be signable via standard tools (cosign,
  age)? **Probably**; pending demand.
