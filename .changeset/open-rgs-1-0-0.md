---
"@open-rgs/contract": major
"@open-rgs/core": major
"@open-rgs/log": major
"@open-rgs/platform-mock": major
"@open-rgs/adapter-kit": major
"@open-rgs/adapter-test-kit": major
"@open-rgs/simulator": major
"@open-rgs/client": major
---

open-rgs 1.0.0 — first stable release.

This release follows a full production-readiness audit; every Critical, High, Medium, and Low finding has been resolved. Highlights:

- **Money math** is integer minor units end to end, rounded half-to-even at the single settle boundary, with safe-integer guards that fail loud instead of silently corrupting past 2^53 (ADR-002).
- **Fairness & isolation**: RNG is injected and fail-closed in production; the Lua math runtime is sandboxed (denylisted globals, host-routed `math.random`) with an instruction-budget execution watchdog.
- **Integrity**: stable per-round idempotency keys, per-session serialization, and a hash-chained tamper-evident audit log.
- **Operations**: authenticated and network-isolatable admin surface, accurate `/healthz` versioning, frame-size limits, and value-level log redaction.
- **Adapter contract**: the autoclose backstop is a hard conformance requirement and the conformance suite proves real idempotency/error-path safety.

The public surface (`@open-rgs/contract` + `@open-rgs/core`) is now considered stable under semver. All eight `@open-rgs/*` packages move to 1.0.0 together for this milestone; subsequent releases version independently.
