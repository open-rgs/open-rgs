# @open-rgs/adapter-test-kit

## 1.1.0

### Minor Changes

- [#59](https://github.com/open-rgs/open-rgs/pull/59) [`9652a2c`](https://github.com/open-rgs/open-rgs/commit/9652a2c9baa7a807e607b4683848286e3582de09) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Opt-in concurrency certification: `runConformance(adapter, { concurrency:
true })` (CLI `--concurrency`) adds four checks for the surface the
  orchestrator's per-session lock does NOT shield an adapter from. Parallel
  settles across distinct sessions must conserve each session's balance; the
  same idempotencyKey fired twice CONCURRENTLY (an in-flight duplicate, not
  the sequential retry the existing dedupe check covers) must settle exactly
  once with one receipt; concurrent reversals of two stacked rounds must stay
  latest-first per the contract's CONCURRENCY rule on `reverseRound` - both
  legal serializations accepted, over-refund and double-credit failed - with
  a clean skip when the adapter doesn't implement the optional `reverseRound`;
  and a plain sequential settle must still reconcile after the storms. Off by
  default (reported as skips, like skipComplex) because the checks open
  derived sessions and assume independent balances - mock/sandbox wallets
  only. Validated against the reference @open-rgs/platform-mock, plus a
  deliberately racy adapter (read-then-write dedupe gap) the new duplicate
  check flags where the sequential one passes it.

### Patch Changes

- Updated dependencies [[`0e82986`](https://github.com/open-rgs/open-rgs/commit/0e82986fa98e82bc6bf1df8904239f454c30ad56), [`c029ad3`](https://github.com/open-rgs/open-rgs/commit/c029ad37eb817e8b700d80c2691102e0c15a4a84)]:
  - @open-rgs/contract@1.2.0

## 1.0.1

### Patch Changes

- Updated dependencies [[`a414783`](https://github.com/open-rgs/open-rgs/commit/a41478386a0f2ba44dbf632405f73be0d0e105bc), [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc)]:
  - @open-rgs/contract@1.1.0

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
