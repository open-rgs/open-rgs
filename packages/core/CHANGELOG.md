# @open-rgs/core

## 1.0.1

### Patch Changes

- [#76](https://github.com/open-rgs/open-rgs/pull/76) [`d08b205`](https://github.com/open-rgs/open-rgs/commit/d08b205fcd3dfec10cba6543cc4cf54155cf63c9) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Admin handler now matches each canonical route in BOTH the prefixed
  (`adminRouteBasePath + route`) and the bare (`route`) shape when
  `adminRouteBasePath` is configured.

  Why: a public ingress that mounts admin under `/api/<service>/*` and
  forwards without rewriting sends the prefixed path, while k8s
  livenessProbe/readinessProbe and the Docker HEALTHCHECK hit the pod
  IP directly with the bare path. Previously you had to pick one  - now
  both work from the same image. Matching is still EXACT (`===`) for
  both shapes, so the `/wss/admin/autoclose` suffix-injection hole the
  audit closed stays closed.

## 1.0.0

### Major Changes

- [#72](https://github.com/open-rgs/open-rgs/pull/72) [`a076f76`](https://github.com/open-rgs/open-rgs/commit/a076f76b9f2a7c02070dd350d15ed13b3ddefd29) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - open-rgs 1.0.0  - first stable release.

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
