---
"@open-rgs/core": patch
---

Fix two defects in the guarded (watchdog) Lua invocation path that killed a
game-server process under real traffic. (1) STACK LEAK: wasmoon's
callByteCode moves a chunk's return value onto the global Lua stack to read
it but never pops it - every guarded call leaked one slot, and after ~40
calls the VM faulted (WASM "Out of bounds memory access") and all later
interop pushes failed ("metatable not found: js_proxy"); a pod died after a
few dozen spins, sequentially, no concurrency needed. The loader now
restores a stack watermark after every guarded chunk. (2) INTERLEAVING: the
guarded path writes call args as VM globals and then runs an async doString
chunk; the orchestrator's per-session lock only serializes one session, so
concurrent sessions could interleave arg-writes into an in-flight chunk.
Guarded invocations now take a per-VM turnstile. Money was never at risk -
failed calls fail closed before any wallet RPC - but a production pod shed
most of its traffic as INTERNAL_ERROR. The watchdog-off direct path
(trusted bulk simulation) is unchanged.
