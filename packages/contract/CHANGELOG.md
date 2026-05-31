# @open-rgs/contract

## 1.1.0

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

- [`eebbc29`](https://github.com/open-rgs/open-rgs/commit/eebbc29e47bd084ab576b95e2450c1b661e416fc) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Add an optional `PlatformAdapter.reverseRound` for wallet-initiated reversal
  (chargeback / reconciliation), formalizing Guarantee 2 - "One Round, One
  Record" (`specs/00-guarantees.md`).

  A reversal MUST undo **both** halves of a round atomically - the balance delta
  AND the carry it produced - and is **latest-first**: only the most recent
  un-reversed round may be reversed, so reversing an older round can't restore a
  stale snapshot and silently over-refund the newer rounds on top of it. An
  unknown or already-reversed round is a safe no-op (`reversed: false`), never a
  double credit.

  - `@open-rgs/contract`: new optional method `reverseRound?(req: ReverseRound):
Promise<ReverseReceipt>` plus the `ReverseRound` / `ReverseReceipt` types.
    Additive and optional - existing adapters compile and run unchanged.
  - `@open-rgs/platform-mock`: the reference wallet now implements `reverseRound`
    correctly (per-session LIFO stack of pre-round balance+carry snapshots) and
    persists carry on settle so the whole-record property is real. The
    `safety.test.ts` suite proves whole-record reversal, out-of-order rejection,
    no-double-credit, and complex-round reversal.

  Spec: `specs/05-platform-protocol.md` gains a "Reversal" subsection.

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
