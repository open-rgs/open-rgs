# @open-rgs/core

## 1.5.0

### Minor Changes

- [#34](https://github.com/open-rgs/open-rgs/pull/34) [`586e4a1`](https://github.com/open-rgs/open-rgs/commit/586e4a16d1389db650d34039b8574a9cbe2ace24) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(core): complex WASM math (open/step/close) in loadWasmMath

  `loadWasmMath` now supports **complex** kernels (`kind=1`) - `open` / `step` /
  `is_terminal` / `close` plus optional `autoclose` - not just simple `play`.

  The loader owns the state boundary: a complex round's `state` is an opaque
  _string_ in the contract, but a kernel's state is bytes, so the kernel emits
  `state` as a MessagePack `bin` and the loader base64-encodes it into the
  `RoundState` string (and decodes it back before the next call). The kernel stays
  binary-native; core sees an opaque string it threads across calls.

  Worked Zig example in `examples/cash-ladder`; ABI pinned in
  `specs/03-math-runtime.md`. Note: `createMathPool` is still simple-only, so a
  complex WASM kernel has no fail-closed execution timeout yet - keep complex
  kernels trusted and bounded.

- [#23](https://github.com/open-rgs/open-rgs/pull/23) [`d08ee95`](https://github.com/open-rgs/open-rgs/commit/d08ee955c6f8668a6520536f012e5201586fb784) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - perf(core): Lua-native `host` table (~3–5× on RNG-heavy math) + opt-in `rngMode: "seed-expand"`

  The math `host` was a JS-backed object, so every `host.rng_next()` — read once per draw — crossed the JS↔WASM boundary through the proxy's `__index` (~4.3 µs/access, measured), dominating draw-heavy math. `host` is now built as a pure Lua table that references the JS hooks, making `host.rng_next` a cheap Lua index. Measured **~3.1× (10 draws/spin) to ~5.3× (50 draws/spin)** faster on the RNG hot path — by default, with no behaviour or certification change (the same injected `rng` still determines outcomes).

  New opt-in `loadLuaMath({ rngMode: "seed-expand" })`: draws one seed per math call from the injected `rng` and expands it in-VM with **xoshiro256++** (multiply-free; bit-verified against a reference; uniform), so the math draws with zero per-draw crossings — a further win for draw-heavy math (**~9.2× vs the old default at 50 draws/spin**). Each call is reseeded independently and the generator is hidden from the (untrusted) math. CERT NOTE: under `"seed-expand"` the expansion enters the outcome-determination path and must be evaluated as part of the RNG; the default stays `"per-draw"` (unchanged).

- [#30](https://github.com/open-rgs/open-rgs/pull/30) [`6ad4e0e`](https://github.com/open-rgs/open-rgs/commit/6ad4e0efc3dd418f59d6f8197b6f419444804379) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(core): `createMathPool` — run WASM math in a worker pool, off the I/O thread

  `createMathPool({ wasmPath, size, timeoutMs })` runs a WASM math kernel across a pool of Worker threads, off the orchestrator's I/O thread, and returns a `SimpleMath`-shaped async math (plus `shutdown()`).

  - **Performance:** math executes on worker threads → concurrency under load; a single spin never blocks the event loop.
  - **Round-level fail-closed:** a call that overruns its `timeoutMs` budget rejects with `MATH_TIMEOUT` (the round refuses to pay a hung/overrunning value, and the connection isn't left waiting) and the worker is replaced, so the pool stays usable.

  **Not a portable no-DoS sandbox.** Failing the round closed is the portable guarantee; the worker is also `terminate()`d, but whether terminate() kills a tight synchronous runaway (`while(true){}`) is platform-dependent — in our testing it did on Linux, did not on Bun+macOS — so on some platforms a runaway thread can leak (keep a core busy). Treat WASM kernels as **trusted and bounded** (same posture as bare `loadWasmMath`); the pool buys off-thread concurrency + round-level failure. A hard, cross-platform no-DoS kill needs process isolation (SIGKILL) — a follow-up. (Only the Lua loader's in-VM `debug.sethook` watchdog preempts a tight loop on any platform.)

  Each worker loads the kernel with a worker-local secure RNG (`cryptoRng`). v1 covers simple (single `play`) WASM math; complex (`open`/`step`/`close`) and a process-isolated no-DoS pool are follow-ups.

- [#25](https://github.com/open-rgs/open-rgs/pull/25) [`4bb55e1`](https://github.com/open-rgs/open-rgs/commit/4bb55e11aafdd07f49a69a937253ca5d7a2ac9d3) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(core): `loadWasmMath` — WASM math kernels (simple), ~14× faster than Lua

  New `loadWasmMath(path, opts)` loads a `.wasm` math kernel conforming to the spec ABI (specs/03-math-runtime.md) and adapts it to `MathModule` — the orchestrator can't tell it from a Lua math. A WASM kernel runs **~14× faster than the equivalent Lua math** (measured on identical math; reproduce with `examples/twin-slot/src/bench.ts`): it calls the `host.rng_next` import directly with no per-draw JS↔WASM proxy tax, stays **sandboxed by construction**, and ships as a **hashable artifact** for certification. I/O is MessagePack over linear memory; RNG resolution is shared with `loadLuaMath` (secure system CSPRNG by default, fail-closed in production). A reference Zig kernel and the built `.wasm` are in the core test fixtures.

  Scope (this entry): **simple** math (single `play`); **complex** WASM math (`open`/`step`/`close`/`is_terminal`) ships in the same release as its own change. Internal: the Lua→TS outcome adapters were extracted to a shared `math-adapt` module so both loaders normalise outcomes identically, and `resolveRng` is shared so the WASM loader inherits the exact secure-default / fail-closed policy.

## 1.4.0

### Minor Changes

- [#21](https://github.com/open-rgs/open-rgs/pull/21) [`a6ae9ec`](https://github.com/open-rgs/open-rgs/commit/a6ae9ecda7d7280bf7995dd36fe73bcb0edd2da8) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - feat(core): default the math RNG to the system CSPRNG (`cryptoRng`), never `Math.random`

  `loadLuaMath` now defaults to `cryptoRng` — a new exported helper backed by the system CSPRNG via WebCrypto (`getRandomValues` → BoringSSL/OpenSSL, the same source Bun's `crypto` uses), returning a uniform 53-bit float in `[0,1)`. Outcome randomness is therefore cryptographically secure by default, and `Math.random` (V8 xorshift128+, non-crypto, unseedable) is never used to determine outcomes — previously it was the dev/no-rng fallback.

  Production still **fails closed** when no `rng` is injected (Guarantee 5 intact), so operators choose their source consciously: pass `{ rng: cryptoRng }` for the system CSPRNG, or inject a jurisdiction-certified (auditable, seed-commit) source. `cryptoRng` is exported from `@open-rgs/core`.

## 1.3.2

### Patch Changes

- [#16](https://github.com/open-rgs/open-rgs/pull/16) [`61d746a`](https://github.com/open-rgs/open-rgs/commit/61d746ac3f8d1df20b806c1db3f368797847c5c9) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - perf(core): run Lua math through the JS bridge instead of recompiling a chunk per call

  With the execution watchdog on (the default), every math entry-point call previously built a Lua source string and ran it through `lua.doString`, which lexes + compiles a fresh chunk each call — and accumulates one per call, so a sustained loop (simulation, a busy server) degrades badly. The watchdog now arms its instruction-count abort hook _inside_ a guarded dispatcher that is invoked through wasmoon's JS function bridge, so the math runs with no per-call recompilation and returns synchronously (no forced Promise/microtask). The watchdog still aborts a runaway math with `MATH_TIMEOUT`, the sandbox lockdown is unchanged, and outcomes are byte-identical. With the example math, watchdog-on now runs within ~6% of watchdog-off (200k spins in ~4.2s); the previous path could not complete the same run.

## 1.3.1

### Patch Changes

- [#14](https://github.com/open-rgs/open-rgs/pull/14) [`389d8cc`](https://github.com/open-rgs/open-rgs/commit/389d8cc0c293a6c0540a2e85b0f811c663d1b9b4) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - perf(core): session-cache eviction no longer snapshots and sorts the whole map on the INIT hot path

  At `MAX_CACHED_SESSIONS` capacity, `put()` previously copied every session into an array, filtered, and full-sorted by `createdAt` (O(n log n) plus a large transient allocation) on every INIT. It now walks the `Map` in insertion (creation) order and drops the oldest idle sessions in O(evicted) with no allocation. Behaviour is unchanged: sessions with an open round are never evicted, and the cache is trimmed to the same low-water mark.

## 1.3.0

### Minor Changes

- [`a414783`](https://github.com/open-rgs/open-rgs/commit/a41478386a0f2ba44dbf632405f73be0d0e105bc) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Add an opt-in transport replay guard - Guarantee 6 ("At Most Once") enforced at
  the socket, so replay-safety no longer depends solely on the wallet deduping.

  Enable with `binaryTransport({ replayGuard: true })`. Each request then carries a
  per-connection monotonically increasing integer under the reserved key `$seq`
  (`WIRE_OPSEQ_KEY`, new export from `@open-rgs/contract`). The transport processes
  `last+1`, **replays the cached response** for an exact re-send of `last` (a
  dropped-response retry -> no re-run, no double settle), and **rejects** a gap or a
  missing/non-integer sequence.

  Off by default and fully backward-compatible: a client that doesn't stamp `$seq`
  is unaffected. `PING` is exempt. This is the standard monotonic-sequence dedup
  pattern for an at-least-once message channel, applied at the socket so it
  backstops the wallet's own idempotency. Spec: `specs/04-wire-protocol.md`.

- [`0ccfded`](https://github.com/open-rgs/open-rgs/commit/0ccfdedc09a00247aa0208e8c275dcb458a72e94) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Stamp a named `RoundOutcomeStatus` on every audit event, making Guarantee 1
  ("No Money, No Honey") auditable. The engine's verdict on the money - `settled`,
  `settled-max-win`, `opened`, `autoclosed`, `failed-bet`, `failed-win`,
  `rejected` - is recorded independently of the math's free-form `type`, giving the
  audit log an explicit money-outcome lifecycle rather than just the math's tag.

  The load-bearing case: a **declined bet now logs `failed-bet` with `win = 0`**
  (in the settle and open failure paths) and is **never** recorded as `settled` -
  so an auditor can confirm no phantom settlement exists for a round whose money
  never moved.

  `outcomeStatus` is optional on `AuditInput` and defaults to `settled` when
  omitted, so hand-built audit inputs and the hash chain stay backward-compatible
  (the field is appended at the tail of the hashed tuple). New export:
  `RoundOutcomeStatus`. Specs: `00-guarantees.md` (Guarantee 1).

### Patch Changes

- Updated dependencies [[`a414783`](https://github.com/open-rgs/open-rgs/commit/a41478386a0f2ba44dbf632405f73be0d0e105bc), [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc)]:
  - @open-rgs/contract@1.1.0

## 1.2.0

### Minor Changes

- [#80](https://github.com/open-rgs/open-rgs/pull/80) [`c9b0576`](https://github.com/open-rgs/open-rgs/commit/c9b05763c1e6e8f92ad68e72743c31ad8563e9b7) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **Stake multiplier now rides on `priceMultiplier`, not `bet`.**

  A fractional `stakeMultiplier` like ante's 1.25x combined with a 1-unit
  base bet used to throw `INVALID_BET: computed bet must be a non-negative
integer minor unit ... got 1.25` because the orchestrator folded stake
  into bet (`base x priceMul x stake`), then asserted the result was an
  integer minor unit (audit H1). Any game with a fractional stake was
  unplayable.

  Fix:

  - `computeBet` now produces `bet = base x clientPriceMul` (integer
    minor units, audit H1 preserved). The mode's `stakeMultiplier` is no
    longer folded into bet.
  - `effectiveCost = bet x stakeMultiplier` is exposed on the bet info
    - persisted on `OpenRound`, used for balance check, max-win cap input,
      win calculation (`settleAmount(multiplier, effectiveCost)`), and the
      audit log's "what was paid" semantic.
  - The wire `priceMultiplier` passed to platforms remains
    `clientPriceMul x stakeMultiplier` (unchanged) - that's where the
    stake fold lives. A wallet computes its own debit at
    `bet x priceMultiplier` with currency-precision handling.
  - `platform-mock` updated to debit `bet x priceMultiplier` (was just
    `bet`) so the bundled dev wallet honours the new semantics.

  Wire-level changes for game integrators:

  - `ClientResponseSpin.bet` is now `base x clientPriceMul` (was
    `base x clientPriceMul x stakeMultiplier`). Clients computing total
    cost should use `bet x priceMultiplier` from the mode catalog, or
    read it from a future explicit `cost` field.
  - `SettleSimple.bet` / `OpenComplex.bet` likewise carry the stake-free
    integer value. Adapters that read `priceMultiplier` (already most of
    them) need no changes; adapters that read `bet` as cost must multiply
    by `priceMultiplier`.

  Free-round modes (`stakeMultiplier: 0`) still debit 0 - effective cost
  collapses correctly and the H4 funded-win guard still rejects winning
  multipliers on a 0-cost mode.

  Audit tests cover ante 1.25x, buy-mode 59x, and explicit-priceMul
  composition (`priceMul=3` on a 1.25-stake ante -> wire priceMultiplier
  3.75).

## 1.1.0

### Minor Changes

- [#78](https://github.com/open-rgs/open-rgs/pull/78) [`f2d9731`](https://github.com/open-rgs/open-rgs/commit/f2d9731a8822e915944999b24a8bb2d66d912b0a) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Add `adminPublicHealthz` (alias `publicHealthz` on `AdminConfig`) to
  serve `/healthz` WITHOUT auth even when `requireAuth` is on. Same JSON
  shape, same diagnostics - just no Bearer token required.

  Use this when an operator dashboard or external uptime prober needs
  to read `/healthz` from somewhere that can't inject a token (a
  browser, a third-party prober, a CI smoke test that doesn't ship the
  operator secret), and you've accepted that core/game/math versions,
  uptime, session count, and platform connection state are public.
  `/admin/*` is unaffected - still gated when `requireAuth` is on or a
  token is configured.

  For plain "is it up?" probes prefer `/readyz` (already always open,
  returns 503 when the platform is down). This flag opens the rich
  diagnostic too. Default false - back-compatible.

## 1.0.1

### Patch Changes

- [#76](https://github.com/open-rgs/open-rgs/pull/76) [`d08b205`](https://github.com/open-rgs/open-rgs/commit/d08b205fcd3dfec10cba6543cc4cf54155cf63c9) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Admin handler now matches each canonical route in BOTH the prefixed
  (`adminRouteBasePath + route`) and the bare (`route`) shape when
  `adminRouteBasePath` is configured.

  Why: a public ingress that mounts admin under `/api/<service>/*` and
  forwards without rewriting sends the prefixed path, while k8s
  livenessProbe/readinessProbe and the Docker HEALTHCHECK hit the pod
  IP directly with the bare path. Previously you had to pick one - now
  both work from the same image. Matching is still EXACT (`===`) for
  both shapes, so the `/wss/admin/autoclose` suffix-injection hole the
  audit closed stays closed.

## 1.0.0

### Major Changes

- [#72](https://github.com/open-rgs/open-rgs/pull/72) [`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - open-rgs 1.0.0 - first stable release.

  This release follows a full production-readiness audit; every Critical, High, Medium, and Low finding has been resolved. Highlights:

  - **Money math** is integer minor units end to end, rounded half-to-even at the single settle boundary, with safe-integer guards that fail loud instead of silently corrupting past 2^53 (ADR-002).
  - **Fairness & isolation**: RNG is injected and fail-closed in production; the Lua math runtime is sandboxed (denylisted globals, host-routed `math.random`) with an instruction-budget execution watchdog.
  - **Integrity**: stable per-round idempotency keys, per-session serialization, and a hash-chained tamper-evident audit log.
  - **Operations**: authenticated and network-isolatable admin surface, accurate `/healthz` versioning, frame-size limits, and value-level log redaction.
  - **Adapter contract**: the autoclose backstop is a hard conformance requirement and the conformance suite proves real idempotency/error-path safety.

  The public surface (`@open-rgs/contract` + `@open-rgs/core`) is now considered stable under semver. All eight `@open-rgs/*` packages move to 1.0.0 together for this milestone; subsequent releases version independently.

### Patch Changes

- Updated dependencies [[`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29)]:
  - @open-rgs/contract@1.0.0
  - @open-rgs/log@1.0.0
