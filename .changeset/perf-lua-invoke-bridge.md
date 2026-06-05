---
"@open-rgs/core": patch
---

perf(core): run Lua math through the JS bridge instead of recompiling a chunk per call

With the execution watchdog on (the default), every math entry-point call previously built a Lua source string and ran it through `lua.doString`, which lexes + compiles a fresh chunk each call — and accumulates one per call, so a sustained loop (simulation, a busy server) degrades badly. The watchdog now arms its instruction-count abort hook *inside* a guarded dispatcher that is invoked through wasmoon's JS function bridge, so the math runs with no per-call recompilation and returns synchronously (no forced Promise/microtask). The watchdog still aborts a runaway math with `MATH_TIMEOUT`, the sandbox lockdown is unchanged, and outcomes are byte-identical. With the example math, watchdog-on now runs within ~6% of watchdog-off (200k spins in ~4.2s); the previous path could not complete the same run.
