# Spec 06 — Performance

## Goal

Define concrete latency and throughput budgets, the runtime choices
that achieve them, and the escalation paths when default choices
aren't enough. State both how Bun is used and where Zig fits.

## Budgets (per-spin, simple round, no wallet)

These are the *server-side compute* budgets, excluding network round
trips to the wallet and to the client.

| Stage | p50 | p99 | Hard cap |
|-------|-----|-----|----------|
| WS frame in + msgpack decode | 5 µs | 20 µs | 100 µs |
| Session lookup + mode resolve + bet compute | 1 µs | 5 µs | 50 µs |
| Math call (Lua via wasmoon) | 50 µs | 150 µs | 1 ms |
| Math call (Zig→WASM) | 5 µs | 20 µs | 100 µs |
| Math call (TS in-process) | 1 µs | 5 µs | 50 µs |
| msgpack encode + WS frame out | 5 µs | 20 µs | 100 µs |
| **Total server compute (Lua)** | **~60 µs** | **~200 µs** | **1.5 ms** |
| **Total server compute (Zig→WASM)** | **~15 µs** | **~50 µs** | **300 µs** |

End-to-end latency observed by the player is dominated by the wallet
RPC (typically 5–50 ms one-way to WebSocket-based providers) and the
client's WebSocket distance (5–100 ms). Server compute is rounding
error.

## Throughput budget

Per single Bun process on a modern x86 core (Apple M-series or AMD
Zen4):

| Workload | Target | Stretch |
|----------|--------|---------|
| Simple spins / sec / core (Lua) | 5,000 | 20,000 |
| Simple spins / sec / core (Zig WASM) | 30,000 | 100,000 |
| Concurrent WS connections / process | 10,000 | 50,000 |
| Mid-round step calls / sec / core (in-process) | 100,000 | 500,000 |

These are well above realistic player loads (10K concurrent players ×
30 spins/sec/player = 300K spins/sec spread across cores). The point
is having headroom for tuning runs and simulator workloads.

## Bun usage — what makes the orchestrator fast

### Runtime choice rationale

- **uWebSockets** under the hood for `Bun.serve` — multi-thousand WS
  per core with negligible overhead.
- **Native MessagePack** via `@msgpack/msgpack` (JS impl, but Bun's V8
  optimizes it well). No transcode overhead.
- **No Node.js loader tax** — Bun starts modules in milliseconds,
  imports `.ts` directly, no transpile step.
- **`bun:ffi`** for native interop when needed (e.g., LuaJIT, custom RNG).

### Patterns we use

- **Single shared wallet WS** per process. All sessions multiplex over
  it with a pending-RPC `Map<corrId, promise>`. No connection-per-session.
- **In-memory `Map<sid, LocalSession>`** as the session store. O(1)
  lookup. No DB on the hot path.
- **Sync math calls** via Bun's WASM bridge. Wasmoon's `lua.call()`
  returns synchronously for sync Lua functions; we don't wrap it in
  unnecessary `await`s.
- **No per-request allocation** in the orchestrator's mode-resolve and
  bet-compute paths. Object literals returned to the transport are the
  only allocations.
- **Pre-warmed Lua VMs** — every math file gets one VM at boot, reused
  for every call. No per-spin VM creation.

### Patterns we avoid

- **Promise.all without need** — adds microtask overhead. Sequential
  awaits where dependencies are real.
- **JSON in hot paths** — MessagePack throughout. JSON only for admin
  endpoints.
- **Chained `Array.prototype` methods** in hot loops (`.map().filter()`)
  — explicit `for` loops where they matter.
- **String concatenation for ops** — math returns ops as objects; no
  string serialization until the msgpack encoder runs at the boundary.

### Bun-specific APIs we lean on

| API | Use |
|-----|-----|
| `Bun.serve` | Both transport WS and admin HTTP |
| `Bun.serve<WsData>` | Per-WS state attached at upgrade time |
| `Bun.file` | Static assets when serving the demo client |
| `crypto.randomUUID()` | Native, fast — used for round / connection IDs |
| `performance.now()` | High-res timing for diagnostics |
| `bun --watch` | Dev hot-reload |
| `bun:test` | Unit tests (planned) |
| `bun:ffi` | Native interop (planned, e.g., LuaJIT path) |

### Bun versions we target

- Minimum: Bun 1.1.0.
- Recommended: latest stable.
- We do NOT target Node compatibility. Code that uses Bun-specific APIs
  is fine in core; alternative runtimes can implement equivalent
  shims if needed.

## Zig usage — where it fits

### When to reach for Zig

In rough order of likelihood:

1. **Production-grade math kernels going to certification.** Same
   contract as a Lua math, compiled to WASM, hashable artifact for
   regulators. The math designer writes Zig instead of Lua.
2. **Simulator binary for billion-spin runs.** A standalone Zig CLI
   that loads the same WASM artifact and runs millions of spins per
   second. Used by `@open-rgs/cli`.
3. **Custom RNG sources.** A Zig-built RNG sidecar (e.g., wrapping a
   certified DLL via FFI) is small and predictable.
4. **Performance-critical orchestrator hot paths.** If profiling shows
   msgpack codec or session-store lookup is the bottleneck (it
   currently isn't), rewrite the inner loop in Zig→WASM.

### Why Zig specifically

- **Comptime evaluation.** Reel-strip weights, paytables, RTP-target
  invariants — all checkable at build time. The compiler refuses to
  emit a binary that fails the invariants.
- **No GC pauses.** A math kernel runs the same ~5 µs every call,
  every time, forever. Lua-on-WASM is fast but has occasional GC
  spikes; Zig has none.
- **No JIT warmup.** First call is as fast as the millionth. Matters
  for cold-start scenarios and for predictability.
- **Cross-target.** Same `.zig` source compiles to native (for the
  simulator) and WASM (for the production server). Identical
  behaviour byte-for-byte.
- **Tiny output.** A typical math kernel WASM is 50–200 KB. Easy to
  ship, easy to hash, easy to audit.
- **Honest interop.** Zig's C ABI is clean. A Lua math can call into a
  Zig-built helper if needed, with no marshalling fuss.

### Zig math kernel: minimum shape

```zig
// build with: zig build-lib play.zig -target wasm32-freestanding \
//   -dynamic --export=play --export=alloc --export=free \
//   -O ReleaseFast

const std = @import("std");

extern "host" fn rng_next() f64;

const WEIGHTS = [_]u32{ 70, 25, 5 };
const PAYS    = [_]f64{ 0,  2,  9 };

comptime {
    // RTP invariant: refuse to compile if EV/sum > 0.96
    var sum: u32 = 0;
    var ev:  f64 = 0;
    for (WEIGHTS, 0..) |w, i| { sum += w; ev += @as(f64, @floatFromInt(w)) * PAYS[i]; }
    if (ev / @as(f64, @floatFromInt(sum)) > 0.96) {
        @compileError("declared RTP exceeded by paytable — retune");
    }
}

export fn play(prev_p: [*]const u8, prev_l: usize,
                ctx_p:  [*]const u8, ctx_l:  usize,
                out_p:  [*]u8, out_max: usize) usize {
    _ = prev_p; _ = prev_l; _ = ctx_p; _ = ctx_l;

    const r = rng_next();
    const total: f64 = @floatFromInt(WEIGHTS[0] + WEIGHTS[1] + WEIGHTS[2]);
    const r_scaled = r * total;

    var idx: usize = 0;
    var acc: f64 = 0;
    for (WEIGHTS, 0..) |w, i| {
        acc += @floatFromInt(w);
        if (r_scaled < acc) { idx = i; break; }
    }

    const mult = PAYS[idx];

    // Encode { multiplier, ops, type } as MessagePack into out_p.
    // (Skipping the encoder code here for brevity — reference impl in repo.)
    return msgpack_encode_outcome(out_p, out_max, mult, idx);
}

export fn alloc(n: usize) [*]u8 { /* bump allocator */ }
export fn free(p: [*]u8) void   { /* no-op for bump */ }
```

The `comptime` block is the killer feature — *that paytable cannot
ship if it would exceed 96% RTP*. Math labs would normally catch this
in simulation; Zig catches it in CI.

### Bun ↔ Zig WASM bridge

- Build artifact: `play.wasm` placed alongside the Lua maths.
- Manifest entry references it: `math: "./maths/zig-slot/play.wasm"`.
- Loader (`@open-rgs/core` `loadWasmMath`): instantiates with imports
  `host.rng_next`, `host.log_debug`. Calls exports via the typed wrapper.
- Same `MathModule` interface — orchestrator can't tell.

### Where Zig is NOT recommended

- The orchestrator itself. Bun + V8 is fast enough; readability and
  iteration speed matter more than the marginal speedup.
- The platform adapter. I/O-bound; FFI overhead doesn't help.
- The transport layer. Same.
- Demo / prototype maths. Lua is faster to write and debug. Port to Zig
  when the math goes to certification.

## RNG performance

The RNG is the hottest path in production for some games (e.g., a math
that calls `rng_next` 50 times per spin). Budget:

| RNG | per call |
|-----|----------|
| `Math.random` | ~10 ns |
| Seeded xoshiro256** (TS) | ~15 ns |
| Certified .NET sidecar (HTTP, buffered) | ~50 ns amortized |
| LuaJIT `math.random` (FFI) | ~5 ns |

The buffered certified sidecar pre-fetches batches of 100 ints and
serves them synchronously from a JS array. Refill happens in the
background when the buffer drops below threshold. A spin that consumes
50 RNG values incurs zero network round-trips at p99.

## Profiling and measurement

- `/healthz` exposes per-method counters and rolling latency
  histograms (planned: full Prometheus metrics).
- `Bun --inspect` for ad-hoc CPU sampling. Flame graphs via Chrome
  DevTools.
- Standalone benchmark harness in `bench/` (planned) runs a synthetic
  spin workload against a mock wallet and reports throughput.

## Acceptance criteria

- A simple-round spin against the mock wallet completes server-side in
  ≤ 200 µs at p99 on a modern x86 core, using the Lua reference math.
- Throughput on a 16-core machine ≥ 80,000 simple spins/sec for a
  trivial Lua math, ≥ 400,000 spins/sec for a Zig→WASM math.
- A complex-round step (no wallet call) completes in ≤ 80 µs at p99
  with Lua, ≤ 30 µs with Zig WASM.
- WS connection capacity ≥ 10,000 concurrent per process at idle.
- Cold start (process up to first SPIN response) ≤ 500 ms.

## Open questions

- Is wasmoon's per-call FFI overhead the actual bottleneck? Bench it
  once we have the harness. **Pending data.**
- Is LuaJIT-via-`bun:ffi` worth the deployment complexity? Probably
  yes for math houses that want Lua + native speed without compiling
  to WASM. **Pending evaluation.**
- Should we bundle a Zig toolchain in the deploy template, or expect
  builders to bring their own? Right now we expect built `.wasm`
  artifacts in the repo, no Zig at runtime. **Decision: artifacts
  only**, builders use their own Zig.
