---
"@open-rgs/simulator": minor
---

feat(simulator): pluggable complex-round strategy (policy function)

`simulate({ complexStrategy })` accepted only `"first"` / `"random"`. It now also
takes a **policy function** `(ctx) => PlayerAction`, where `ctx` is the public
context at each decision - `awaiting`, the latest public `ops`, the step index,
and the seeded rng. This is how you simulate games whose RTP depends on player
choices: "keep gambling N times", a gamble-to-target rule, an optimal solver.

The strategy deliberately sees only what a real client sees (`awaiting` + `ops`),
never the opaque round `state`, so simulated policies can't cheat on hidden info.

Exports: `StrategyFn`, `StrategyContext`, `ComplexStrategy`. The built-in
`"first"` / `"random"` names are unchanged. (A complementary in-kernel self-play
tier - a fixed policy baked into the WASM kernel for ~native-speed policy sweeps -
is shown in `examples/cash-ladder` via its `sim_ladder` export.)
