# Spec 03  - Math Runtime

## Goal

A math file is a self-contained module implementing `MathModule`. The
math runtime loads it, exposes a host import for randomness (and only
randomness, plus a logger), and adapts the module's outputs into the
canonical TypeScript shapes. Multiple source languages are supported;
the same contract is enforced regardless.

## Supported source forms

| Form | Loader | Use case |
|------|--------|----------|
| `.ts` / `.js` | `loadTsMath` (ES-module import + purity gate) | **Default.** Fastest tier by a wide margin, no boundary tax, best tooling. |
| `.lua` | `wasmoon` (Lua compiled to WASM, embedded in Bun) | Sandboxed by construction, hot-reloadable. Choose when math is untrusted or the author wants Lua. |
| `.wasm` | `WebAssembly.instantiate` | Production-grade math, certification-friendly artifact. Source typically Zig or Rust. |
| (subprocess) | spawn + length-prefixed msgpack stdio | Escape hatch for languages that don't WASM well. Slowest, most flexible. |

`@open-rgs/core` ships a TS loader (`loadTsMath`), a Lua loader
(`loadLuaMath`) and a WASM loader (`loadWasmMath`, both simple and
complex math). All return a `Promise<MathModule>` that the manifest's
`math:` field accepts.

**Measured on identical math** (`examples/twin-slot`, all three runtimes
computing the same game - run `bun examples/twin-slot/src/bench.ts`):

| Tier | per `play()` | spins / sec / core |
|------|-------------:|-------------------:|
| Lua (wasmoon, watchdog on) | 16,643 ns | 60,084 |
| Zig -> WASM | 1,176 ns | 850,016 |
| **TS (in-process)** | **13 ns** | **77,978,628** |

TS is ~1,300x the Lua tier and ~92x the WASM kernel. The gap is not the
language - it is the boundary. wasmoon marshals a fresh Lua table across the
JS<->Lua bridge on every call and a WASM kernel round-trips MessagePack through
linear memory; an in-process TS math has no boundary to cross at all. (This is
also why `lua-math.ts` implements its PRNG *inside* the Lua VM: a crossing per
draw costs more than the arithmetic. A TS math has no such tax.)

That difference is irrelevant to serving - server compute is rounding error
against the wallet RPC (spec 06) - and decisive for **simulation**, where a
tune loop runs millions of spins. It is what makes a same-second RTP iteration
loop possible for a math author.

The WASM tier remains the right choice for math you do not control: it is
sandboxed by construction, bit-deterministic in its float ops, and ships as a
hashable artifact for certification.

**WASM watchdog caveat:** unlike the Lua loader, a running WASM call cannot be
interrupted from JS, so `loadWasmMath` currently has **no per-call timeout** - a
runaway kernel blocks the event loop (a DoS). Treat WASM kernels as trusted and
bounded; `loadWasmMath` logs a warning at load to keep this visible.
**`createMathPool`** runs the kernel on Worker threads instead: it moves math
off the I/O thread and FAILS THE ROUND closed (`MATH_TIMEOUT`) on a budget
overrun, then replaces the worker - the portable guarantee. It is **not a
portable no-DoS sandbox**, though: whether `worker.terminate()` can kill a tight
synchronous runaway is platform-dependent (it did on Linux, did not on Bun+macOS
in our testing), so a runaway thread may leak. Treat **all** WASM kernels as
trusted/bounded; a hard cross-platform no-DoS kill needs process isolation
(SIGKILL), not implemented. (Only the Lua loader's in-VM `debug.sethook` watchdog
preempts a tight loop on any platform.)

## RNG seam

Math NEVER ships its own PRNG. The host provides one:

- **Lua**: `host.rng_next()` returns a float in `[0, 1)`.
- **WASM**: import `host.rng_next` declared as `(): f64`.
- **TS**: a `random: () => number` argument injected at construction.

The host implementation can be **injected at boot** via
`loadLuaMath(path, { rng })`. The default is a secure CSPRNG  - **never
`Math.random`**:

- Default: `cryptoRng`, the system CSPRNG via WebCrypto (`getRandomValues`
  -> BoringSSL/OpenSSL, the same source Bun's `crypto` uses). Exported from
  `@open-rgs/core`. Secure and unpredictable, but a CSPRNG  - not necessarily
  a *certified/auditable* RNG (no seed-commit or consumed-value log).
- Production: must choose the source **consciously**. `loadLuaMath` fails
  closed (throws) under `NODE_ENV=production` when no `rng` is injected  -
  even though a secure default exists  - so the operator picks deliberately.
  Pass `{ rng: cryptoRng }` to use the system CSPRNG, or inject a
  jurisdiction-certified (auditable) source. `Math.random` (non-crypto,
  unseedable, GLI-19/GLI-11 disallowed) is never used.
- Dev / examples: when no `rng` is injected outside production,
  `loadLuaMath` uses `cryptoRng` with a one-line warning. An offline tooling
  job can also opt out of the prod fail-closed with `{ allowInsecureRng: true }`.
- Testing / simulation: a seeded PRNG (e.g. `mulberry32` from
  `@open-rgs/simulator`) for reproducible RTP runs (refused in production
  unless `allowInsecureRng`).

Math produces byte-identical outputs for byte-identical RNG sequences,
because no other source of nondeterminism is exposed.

**Delivery (`rngMode`).** By default (`"per-draw"`) each `host.rng_next()`
calls the injected `rng` directly. The opt-in `"seed-expand"` mode draws one
seed per math call from `rng` and expands it in-VM with xoshiro256++ (seeded
by splitmix64), so the math draws with no per-draw JS<->WASM crossing  - a
large speedup for draw-heavy math. It is reseeded independently per call and
the generator is hidden from the math. Under `"seed-expand"` the expansion
joins the outcome-determination path and must be evaluated as part of the RNG
(re-certify before real-money use); the consumed sequence stays deterministic
and reconstructable from each call's seed.

## Lua runtime details

Loader: `wasmoon` v1.x. Lua 5.4 compiled to WASM, runs in Bun via the
WebAssembly engine. Per-math VM is created at boot and reused for every
call to that math.

Host imports exposed:

```lua
host.rng_next()          -- -> number in [0, 1)
host.log_debug(msg)      -- -> nil; routes to ECS logger at debug level
```

That's it. Before the math file is evaluated the loader locks down the
global environment: `os`, `io`, `debug`, `load`, `loadstring`, `loadfile`,
`dofile`, `package`, and `collectgarbage` are set to `nil`, and
`math.random` / `math.randomseed` are replaced so all entropy is routed
through `host.rng_next` (a math file cannot bypass the auditable RNG seam,
nor read files, open sockets, or read a wall clock). The only module access
is the overridden `require`, which resolves **only** explicitly registered
extensions (never the host filesystem). This is the math trust boundary  -
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
- Adapts return values: 1-indexed Lua tables -> JS arrays where needed.
- Promotes `next_mode` (snake_case in Lua) to `nextMode` (camelCase in TS).
- Bounds execution with a per-call watchdog (`loadLuaMath` `timeoutMs`,
  default 1000ms; `0` disables for trusted bulk simulation). wasmoon runs
  Lua synchronously on the event loop, so a runaway math (`while true do
  end`) would block the whole server for every player with no JS timer able
  to interrupt it. A Lua instruction (count) hook aborts the call with
  `MATH_TIMEOUT` once it passes the deadline. The hook applies to the thread
  it is armed ON, and wasmoon runs each JS->Lua bridge call on its own
  thread, so a guarded dispatcher arms the hook INSIDE the call (its first
  act) before `pcall`-ing the math. That lets each entry point be invoked
  through the JS function bridge - synchronous, no per-call work - rather than
  recompiling a fresh `doString` chunk every call; module construction still
  runs once inside a `doString`, guarded the same way. The hook, its
  `sethook` handle, and the deadline check are captured as upvalues then
  hidden, and the hook survives `debug = nil`, so sandboxed math cannot
  disable it.

## WASM runtime details

A WASM math module exposes these exports:

```
(export "kind"            (func (result i32)))   -- 0=simple, 1=complex
(export "name_ptr"        (func (result i32)))
(export "name_len"        (func (result i32)))
(export "version_ptr"     (func (result i32)))
(export "version_len"     (func (result i32)))
(export "rtp_x10000"      (func (result i32)))   -- RTP x 10000 (0.95 -> 9500)

(export "alloc"  (func (param i32) (result i32)))   -- allocator
(export "free"   (func (param i32)))

;; simple
(export "play"
  (func (param i32 i32 i32 i32 i32 i32) (result i32)))
;;          prev_p prev_l ctx_p ctx_l out_p out_max -> out_len

;; complex  - open/step/close/autoclose return out_len; is_terminal returns 0|1
(export "open"
  (func (param i32 i32 i32 i32 i32 i32) (result i32)))
;;          prev_p prev_l ctx_p ctx_l out_p out_max -> out_len
(export "step"
  (func (param i32 i32 i32 i32 i32 i32) (result i32)))
;;          state_p state_l act_p act_l out_p out_max -> out_len
(export "is_terminal"
  (func (param i32 i32) (result i32)))               ;; state_p state_l -> 0|1
(export "close"
  (func (param i32 i32 i32 i32) (result i32)))       ;; state_p state_l out_p out_max -> out_len
(export "autoclose"
  (func (param i32 i32 i32 i32) (result i32)))       ;; optional; same shape as close
```

Imports it consumes:

```
(import "host" "rng_next" (func (result f64)))
(import "host" "log_debug" (func (param i32 i32)))
```

Buffers carry MessagePack-encoded payloads. The host writes input into
the module's linear memory at a returned `alloc()` pointer, calls the
function, reads the output, then frees both.

**Complex state (the bytes <-> string boundary).** A complex round's `state`
(`RoundState`) is an opaque *string* core stores and threads back into `step` /
`is_terminal` / `close` - the kernel keeps nothing between calls. A kernel's
state is bytes, so it emits `state` as a MessagePack `bin` and the loader
base64-encodes it into the string (and base64-decodes it back before the next
call): the kernel sees bytes, core sees an opaque string. `open` / `step`
return `{ state, ops, awaiting? }` (omit `awaiting` once the round is terminal);
`close` / `autoclose` return `{ multiplier, ops, type, carry?, next_mode? }`.
See `examples/cash-ladder` for a worked Zig kernel, and `examples/twin-slot` /
`examples/twin-gamble` for the **same** math written in *both* Lua and Zig with a
test proving the two runtimes are 1:1 (a simple round and a complex round).

Source language: **Zig is the recommended default** for new WASM math.
See **Spec 06** for performance rationale. Rust, AssemblyScript,
TinyGo, and C all work.

**Running a WASM kernel.** `loadWasmMath(path, { rng })` instantiates the
kernel for direct, synchronous `play()` calls - the fast path, but with no
execution watchdog (a runaway kernel blocks the event loop).
`createMathPool({ wasmPath, size, timeoutMs })` runs the same kernel across
Worker threads: it moves math off the I/O thread and fails the round closed
(`MATH_TIMEOUT`) on a budget overrun, then replaces the worker. It is **not** a
portable no-DoS sandbox, though - killing a tight-loop runaway via
`worker.terminate()` is platform-dependent, so the thread may leak. Both default
to the secure `cryptoRng` and honor the same RNG seam above. Treat WASM kernels
as trusted/bounded; the pool is also simple-only today.

## TS runtime details

A TS math module default-exports a **factory** taking the host, not a bare
math object:

```ts
import type { MathHost, SimpleMath } from "@open-rgs/contract";

export default (host: MathHost): SimpleMath => ({
  kind: "simple", name: "my-slot", version: "1.0.0", rtp: 0.96,
  play: () => {
    const r = host.rng_next();          // the ONLY source of randomness
    return { multiplier: r < 0.02 ? 20 : 0, ops: [], type: "x" };
  },
});
```

Loaded with `loadTsMath(path, { rng })`. Same `MathModule` shape, same
`contentHash` provenance stamp, same RNG policy as the other loaders
(secure CSPRNG by default, fail-closed in production).

**Why a factory and not a bare object.** The factory *is* the RNG seam. Lua
math draws through the `host` global and a WASM kernel imports `host.rng_next`;
neither can reach an ambient generator. A TS module can - `Math.random()` is
one identifier away, it looks correct, and it passes every test you would think
to write while silently destroying seed reproducibility. Injection makes the
guarantee structural instead of aspirational. `loadTsMath` rejects a bare-object
default export for exactly this reason.

### The purity gate

`loadTsMath` scans the source **before importing it** and refuses a module that
references:

| Denied | Why |
|--------|-----|
| `Math.random`, `crypto`, `getRandomValues` | ambient randomness - outcomes must replay from a seed |
| `Date`, `performance.now`, `hrtime` | the clock - math is a pure function of (seed, state) |
| `fetch`, `process`, `require`, dynamic `import` | I/O - no network, no filesystem, no environment |
| `globalThis`, `eval`, `Function(` | dynamic escape hatches |
| `Math.sin/cos/tan/exp/log/pow/...` | implementation-defined floats - a certified RTP would not reproduce across engine builds |

Correctly-rounded operations (`floor`, `ceil`, `round`, `trunc`, `abs`, `min`,
`max`, `sign`, `sqrt`, `fround`) are specified exactly and stay allowed. If a
game genuinely needs a transcendental, it belongs in the WASM tier, whose float
ops are bit-deterministic by design.

Comments and quoted strings are stripped before the scan, so prose about
`Math.random` does not trip it; template-literal holes are *not* stripped, so
`${Math.random()}` still does.

**What this is and is not.** It is a guardrail against accidents - overwhelmingly,
an author (increasingly a language model) reaching for `Math.random()` because
that is the obvious thing to write. It is **not a sandbox**: a determined author
evades a source scan trivially, and once imported the module runs with the host's
full authority. Math you do not control belongs in the WASM tier. This tier
assumes math is authored by the party operating the server, which is the
documented deployment model (spec 00).

`assertPure(src, path)` is exported separately so CI can gate a math file
without loading it.

## Hot reload

Dev-only. The Lua loader exposes `reload(path)` which re-reads the
source, builds a new VM, and atomically swaps the in-memory math
reference. Production builds disable the reload endpoint.

In-flight rounds during a reload finish with the OLD math (no surprise
mid-round behaviour change). New rounds start with the NEW math.

## Math file lifecycle

```
boot                   load all math files referenced by manifest
  v
per-spin               math.play / math.open / step / close
  v
per-spin (in-process)  no I/O, no network, no clock
  v
disconnect             math state evaporates if ephemeral; carry persists if returned
  v
restart                math is reloaded fresh; carry rehydrates from session.carry
```

## Acceptance criteria

- A Lua math file with no `kind` field is rejected at load time with a
  clear error.
- A Lua math file that calls `os.time()`, `io.read()`, or `require()`
  fails at runtime with a "function not available" Lua error
  (`os`/`io`/`require` are not in the global table the loader exposes).
- The Lua loader produces a `MathModule` for which
  `await math.play(...)` resolves in <= 200 uss at p99 on the synthetic
  workload (see **Spec 06**).
- The same Lua source produces identical outputs given identical RNG
  sequences across two independent loader invocations.
- A WASM math module conforming to the exports/imports above is
  interchangeable with a Lua module via a manifest entry change only.

## Open questions

- Should we ship `host.now_ms()` for time-bounded games (e.g., crash
  countdowns)? Adds nondeterminism  - math becomes less reproducible.
  **Probably no**; the deadline lives in `awaiting.deadline`, the host
  enforces it via the autoclose trigger, math doesn't need to read time
  directly. Decision: **no**.
- Should `host.log_debug` accept structured fields rather than a
  string? Useful for debugging at scale. **Pending**, low priority.
- Should we expose a determinism-mode flag that traps any host call
  other than `rng_next`? Useful for proving a math is pure. **Pending.**
