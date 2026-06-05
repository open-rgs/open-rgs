# @open-rgs/core

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
