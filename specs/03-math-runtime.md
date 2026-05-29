# Spec 03 — Math Runtime

## Goal

A math file is a self-contained module implementing `MathModule`. The
math runtime loads it, exposes a host import for randomness (and only
randomness, plus a logger), and adapts the module's outputs into the
canonical TypeScript shapes. Multiple source languages are supported;
the same contract is enforced regardless.

## Supported source forms

| Form | Loader | Use case |
|------|--------|----------|
| `.lua` | `wasmoon` (Lua compiled to WASM, embedded in Bun) | Default. Cheap to write, hot-reloadable, near-zero embedding cost. |
| `.ts` / `.js` | direct ES-module import | Prototyping inside the orchestrator's runtime. No FFI overhead. |
| `.wasm` | `WebAssembly.instantiate` | Production-grade math, certification-friendly artifact. Source typically Zig or Rust. |
| (subprocess) | spawn + length-prefixed msgpack stdio | Escape hatch for languages that don't WASM well. Slowest, most flexible. |

`@open-rgs/core` ships a Lua loader. WASM and TS loaders are planned
peers (`loadWasmMath`, `loadTsMath`). All loaders return a
`Promise<MathModule>` that the manifest's `math:` field accepts.

## RNG seam

Math NEVER ships its own PRNG. The host provides one:

- **Lua**: `host.rng_next()` returns a float in `[0, 1)`.
- **WASM**: import `host.rng_next` declared as `(): f64`.
- **TS**: a `random: () => number` argument injected at construction.

The host implementation is **injected at boot** via
`loadLuaMath(path, { rng })`. There is no real-money default:

- Production: a certified RNG (e.g. a CSPRNG or a jurisdiction-approved
  RNG sidecar) wrapped behind a synchronous `rng.next()`. **Required** —
  `loadLuaMath` fails closed (throws) under `NODE_ENV=production` when no
  `rng` is injected; it will not silently use `Math.random` (non-crypto,
  unseedable, GLI-19/GLI-11 disallowed).
- Dev / examples: when no `rng` is injected outside production,
  `loadLuaMath` falls back to `Math.random` with a loud warning. Acceptable
  for local play only; an offline tooling job can opt in explicitly with
  `{ allowInsecureRng: true }`.
- Testing / simulation: a seeded PRNG (e.g. `mulberry32` from
  `@open-rgs/simulator`) for reproducible RTP runs.

Math produces byte-identical outputs for byte-identical RNG sequences,
because no other source of nondeterminism is exposed.

## Lua runtime details

Loader: `wasmoon` v1.x. Lua 5.4 compiled to WASM, runs in Bun via the
WebAssembly engine. Per-math VM is created at boot and reused for every
call to that math.

Host imports exposed:

```lua
host.rng_next()          -- → number in [0, 1)
host.log_debug(msg)      -- → nil; routes to ECS logger at debug level
```

That's it. Before the math file is evaluated the loader locks down the
global environment: `os`, `io`, `debug`, `load`, `loadstring`, `loadfile`,
`dofile`, `package`, and `collectgarbage` are set to `nil`, and
`math.random` / `math.randomseed` are replaced so all entropy is routed
through `host.rng_next` (a math file cannot bypass the auditable RNG seam,
nor read files, open sockets, or read a wall clock). The only module access
is the overridden `require`, which resolves **only** explicitly registered
extensions (never the host filesystem). This is the math trust boundary —
it is a denylist of the known-dangerous Lua 5.4 surface; an `_ENV`
allowlist is a possible future hardening.

A math file's expected shape:

```lua
local M = {
  kind = "simple",        -- or "complex"
  name = "...",
  version = "...",
  rtp = 0.95,
}

function M.play(prev, ctx) ... end                 -- simple

-- OR for complex:
function M.open(prev, ctx) ... end
function M.step(state, action) ... end
function M.is_terminal(state) ... end
function M.close(state) ... end
function M.autoclose(state) ... end                -- optional

return M
```

The loader:
- Wraps the math source in a closure: `__mod = (function() <source> end)()`.
- Validates `kind` and the required functions exist for that kind.
- Adapts return values: 1-indexed Lua tables → JS arrays where needed.
- Promotes `next_mode` (snake_case in Lua) to `nextMode` (camelCase in TS).
- Bounds execution with a per-call watchdog (`loadLuaMath` `timeoutMs`,
  default 1000ms; `0` disables for trusted bulk simulation). wasmoon runs
  Lua synchronously on the event loop, so a runaway math (`while true do
  end`) would block the whole server for every player with no JS timer able
  to interrupt it. A Lua instruction hook — armed on the executing thread by
  invoking each entry point (and module construction) from inside a
  `doString` chunk, so it actually applies — aborts the call with
  `MATH_TIMEOUT` once it passes the deadline. The hook, its `sethook`
  handle, and the deadline check are captured as upvalues then hidden, and
  the hook survives `debug = nil`, so sandboxed math cannot disable it.

## WASM runtime details (planned)

A WASM math module exposes these exports:

```
(export "kind"            (func (result i32)))   -- 0=simple, 1=complex
(export "name_ptr"        (func (result i32)))
(export "name_len"        (func (result i32)))
(export "version_ptr"     (func (result i32)))
(export "version_len"     (func (result i32)))
(export "rtp_x10000"      (func (result i32)))   -- RTP × 10000 (0.95 → 9500)

(export "alloc"  (func (param i32) (result i32)))   -- allocator
(export "free"   (func (param i32)))

;; simple
(export "play"
  (func (param i32 i32 i32 i32 i32 i32) (result i32)))
;;          prev_p prev_l ctx_p ctx_l out_p out_max → out_len

;; complex
(export "open"        (func ...))
(export "step"        (func ...))
(export "close"       (func ...))
(export "is_terminal" (func ...))
(export "autoclose"   (func ...))
```

Imports it consumes:

```
(import "host" "rng_next" (func (result f64)))
(import "host" "log_debug" (func (param i32 i32)))
```

Buffers carry MessagePack-encoded payloads. The host writes input into
the module's linear memory at a returned `alloc()` pointer, calls the
function, reads the output, then frees both.

Source language: **Zig is the recommended default** for new WASM math.
See **Spec 06** for performance rationale. Rust, AssemblyScript,
TinyGo, and C all work.

## TS runtime details

A TS math module is a normal ES module with a default export
implementing `MathModule`. Loaded by `import()`:

```ts
const mod = await import("./my-math.ts");
const math: MathModule = mod.default;
```

No FFI overhead. Same `MathModule` shape. Use case: rapid prototyping,
testing the orchestrator without spinning up Lua.

## Hot reload

Dev-only. The Lua loader exposes `reload(path)` which re-reads the
source, builds a new VM, and atomically swaps the in-memory math
reference. Production builds disable the reload endpoint.

In-flight rounds during a reload finish with the OLD math (no surprise
mid-round behaviour change). New rounds start with the NEW math.

## Math file lifecycle

```
boot                   load all math files referenced by manifest
  ↓
per-spin               math.play / math.open / step / close
  ↓
per-spin (in-process)  no I/O, no network, no clock
  ↓
disconnect             math state evaporates if ephemeral; carry persists if returned
  ↓
restart                math is reloaded fresh; carry rehydrates from session.carry
```

## Acceptance criteria

- A Lua math file with no `kind` field is rejected at load time with a
  clear error.
- A Lua math file that calls `os.time()`, `io.read()`, or `require()`
  fails at runtime with a "function not available" Lua error
  (`os`/`io`/`require` are not in the global table the loader exposes).
- The Lua loader produces a `MathModule` for which
  `await math.play(...)` resolves in ≤ 200 µs at p99 on the synthetic
  workload (see **Spec 06**).
- The same Lua source produces identical outputs given identical RNG
  sequences across two independent loader invocations.
- A WASM math module conforming to the exports/imports above (when the
  WASM loader ships) is interchangeable with a Lua module via a
  manifest entry change only.

## Open questions

- Should we ship `host.now_ms()` for time-bounded games (e.g., crash
  countdowns)? Adds nondeterminism — math becomes less reproducible.
  **Probably no**; the deadline lives in `awaiting.deadline`, the host
  enforces it via the autoclose trigger, math doesn't need to read time
  directly. Decision: **no**.
- Should `host.log_debug` accept structured fields rather than a
  string? Useful for debugging at scale. **Pending**, low priority.
- Should we expose a determinism-mode flag that traps any host call
  other than `rng_next`? Useful for proving a math is pure. **Pending.**
