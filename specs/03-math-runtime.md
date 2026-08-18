# Spec 03: Math Runtime

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
| `.wasm` | `WebAssembly.instantiate` | Production-grade math, certification-friendly artifact. Source typically Zig or Rust. |
| (subprocess) | spawn + length-prefixed msgpack stdio | Escape hatch for languages that don't WASM well. Slowest, most flexible. |

`@open-rgs/core` ships a TypeScript loader (`loadTsMath`) and a WASM loader (`loadWasmMath`, both simple and
complex math). All return a `Promise<MathModule>` that the manifest's
`math:` field accepts.

**Measured on identical math** (`examples/twin-slot`, all three runtimes
computing the same game - run `bun examples/twin-slot/src/bench.ts`):

| Tier | per `play()` | spins / sec / core |
|------|-------------:|-------------------:|
| Zig -> WASM | 1,176 ns | 850,016 |
| **TS (in-process)** | **13 ns** | **77,978,628** |

TypeScript is ~92x the WASM kernel. The gap is not the language but the
boundary: a WASM kernel round-trips MessagePack through linear memory, and an
in-process TypeScript math crosses nothing at all.

That difference is irrelevant to serving - server compute is rounding error
against the wallet RPC (spec 06) - and decisive for **simulation**, where a
tune loop runs millions of spins. It is what makes a same-second RTP iteration
loop possible for a math author.

The WASM tier remains the right choice for math you do not control: it is
sandboxed by construction, bit-deterministic in its float ops, and ships as a
hashable artifact for certification.

**WASM watchdog caveat:** a running WASM call cannot be
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
(SIGKILL), not implemented. 

## RNG seam

Math NEVER ships its own PRNG. The host provides one:

- **WASM**: import `host.rng_next` declared as `(): f64`.
- **TS**: a `random: () => number` argument injected at construction.

The host implementation can be **injected at boot** via
`loadTsMath(path, { rng })`. The default is a secure CSPRNG, **never
`Math.random`**:

- Default: `cryptoRng`, the system CSPRNG via WebCrypto (`getRandomValues`
  -> BoringSSL/OpenSSL, the same source Bun's `crypto` uses). Exported from
  `@open-rgs/core`. Secure and unpredictable, but a CSPRNG, not necessarily
  a *certified/auditable* RNG (no seed-commit or consumed-value log).
- Production: must choose the source **consciously**. `loadTsMath` fails
  closed (throws) under `NODE_ENV=production` when no `rng` is injected  -
  even though a secure default exists, so the operator picks deliberately.
  Pass `{ rng: cryptoRng }` to use the system CSPRNG, or inject a
  jurisdiction-certified (auditable) source. `Math.random` (non-crypto,
  unseedable, GLI-19/GLI-11 disallowed) is never used.
- Dev / examples: when no `rng` is injected outside production,
  `loadTsMath` uses `cryptoRng` with a one-line warning. An offline tooling
  job can also opt out of the prod fail-closed with `{ allowInsecureRng: true }`.
- Testing / simulation: a seeded PRNG (e.g. `mulberry32` from
  `@open-rgs/simulator`) for reproducible RTP runs (refused in production
  unless `allowInsecureRng`).

Math produces byte-identical outputs for byte-identical RNG sequences,
because no other source of nondeterminism is exposed.

**Delivery (`rngMode`).** By default (`"per-draw"`) each `host.rng_next()`
calls the injected `rng` directly. With a CSPRNG that is unpredictable and
also unreplayable, because a CSPRNG has no seed to write down.

The opt-in `"seed-expand"` mode draws ONE seed per entry-point call from `rng`
and expands it into a uniform stream (splitmix32 seeding sfc32, two 32-bit
draws per float for full 53-bit resolution). The math sees the same uniform
stream; what changes is that the whole call collapses to a single recordable
number, so recording it replays the round exactly. This is a REPLAY feature,
not a performance one - in-process TypeScript has no boundary to dodge.

The stream, and the seed it came from, belong to the CALL: they are held in an
async-local scope that follows the call across its awaits, so two rounds in
flight at once each draw from their own stream. `lastSeed` reads the most
recently started call, which is unambiguous only when calls do not overlap;
`runSeeded(fn)` returns the seed with the call it belongs to and is the form
that stays correct under concurrency. `withSeed(seed, fn)` pins a seed for its
own scope, so a replay does not disturb a live round.

Under `"seed-expand"` the expansion joins the outcome-determination path and
must be evaluated as part of the RNG (re-certify before real-money use); the
consumed sequence stays deterministic and reconstructable from each call's
seed.


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

;; complex, open/step/close/autoclose return out_len; is_terminal returns 0|1
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
`examples/twin-gamble` for the **same** math written in *both* TypeScript and Zig with a
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

**Why a factory and not a bare object.** The factory *is* the RNG seam. A WASM
kernel imports `host.rng_next` and cannot reach an ambient generator. A
TypeScript module can - `Math.random()` is one identifier away, it looks
correct, and it passes every test you would think to write while silently
destroying seed reproducibility. Injection makes the guarantee structural
instead of aspirational, and `loadTsMath` rejects a bare-object default export
for exactly this reason.

### The purity gate

`loadTsMath` scans the math **before importing it** and refuses a module that
references any of the following.

"The math" means every local file it is built from: the loader resolves the
entry's relative imports, transitively, and scans each one. A math split
across files is the ordinary way to write one, and a gate that reads only the
entry catches nothing that lives one import away. Package imports (`@scope/x`,
`node:fs`) are not followed - a dependency is pinned by the lockfile and is not
the author's file tree.

The same set of files produces the `contentHash`, so the provenance stamp in
the audit log identifies the whole math rather than its entry point. Editing a
helper changes the hash, which is exactly what an auditor reconstructing a
round needs it to do.

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

`assertPure(src, path)` is exported separately so CI can gate a single file
without loading it; `collectMathSources(entry)` returns the file set the loader
would scan, and `hashMathSources(entry, files)` the hash it would stamp.

**Reloading edited math.** The loader busts the module cache for the ENTRY file
only - its imports are cached under their own URLs, which nothing rewrites - so
a second `loadTsMath` in the same process picks up an edited entry and keeps
already-imported helpers. It notices: the graph hash changes, and the loader
warns that the process must restart. It does not pretend to have reloaded.

## Hot reload

Dev-only, and narrower than it sounds. `loadTsMath` re-reads the math's files,
rescans them, and re-imports the ENTRY under a cache-busting URL derived from
the graph hash, so an edited entry takes effect and the caller can swap its
math reference. Imported helpers are already in the module cache under their
own URLs and are NOT re-imported - the loader warns when the graph hash moved,
because the alternative is running stale code without saying so. Restart the process
to pick up an edited helper.

In-flight rounds during a reload finish with the math reference they started
on (no surprise mid-round behaviour change). New rounds use the new one.

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

- A math module with no `kind` field is rejected at load time.
- A TypeScript math referencing `Math.random`, the clock or I/O is rejected
  at load time by the purity gate.
- Each loader produces a `MathModule` for which
  `await math.play(...)` resolves in <= 200 uss at p99 on the synthetic
  workload (see **Spec 06**).
- The same source produces identical outputs given identical RNG
  sequences across two independent loader invocations.
- A WASM math module conforming to the exports/imports above is
  interchangeable with a TypeScript module via a manifest entry change only.

## Open questions

- Should we ship `host.now_ms()` for time-bounded games (e.g., crash
  countdowns)? Adds nondeterminism, math becomes less reproducible.
  **Probably no**; the deadline lives in `awaiting.deadline`, the host
  enforces it via the autoclose trigger, math doesn't need to read time
  directly. Decision: **no**.
- Should `host.log_debug` accept structured fields rather than a
  string? Useful for debugging at scale. **Pending**, low priority.
- Should we expose a determinism-mode flag that traps any host call
  other than `rng_next`? Useful for proving a math is pure. **Pending.**
