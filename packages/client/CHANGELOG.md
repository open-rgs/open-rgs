# @open-rgs/client

## 1.1.0

### Minor Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **Request-level idempotency.** A resent `spin`, `openRound`, `stepRound` or
  `closeRound` carrying the same client token now returns the first call's result
  without running the round again. On by default; `createServer({ requestCache:
false })` restores the previous behaviour, and `{ ttlMs, max }` tunes it.

  open-rgs already derived a stable idempotency key for the wallet, but that
  guarantee depends on the wallet honouring it, and some wallet protocols have no
  field to carry the key at all - `@open-rgs/adapter-artube` is the worked
  example. Against those, a client retry after a timeout ran the math a second
  time and moved money a second time. The cache closes that on our side.

  The entry is created before the work starts, so a repeat arriving _while_ the
  first is still running coalesces onto it rather than starting a second round -
  which is exactly the retry a client timeout produces, and the one a
  completed-response cache would miss. Failures clear their own entry so a
  transient wallet blip cannot permanently poison a token. Entries are scoped by
  session and tagged by phase, so two players cannot collide and one token cannot
  collapse a spin into a close. It is per process: a retry reaching a different
  pod still relies on the wallet's own dedupe.

  **A canonical op vocabulary, opt in.** `@open-rgs/contract/ops` adds nine op
  shapes - `board`, `win`, `cascade`, `respin`, `coin`, `award`, `feature`,
  `meter`, `message` - plus `isCanonicalOp`, `canonicalOps` and `opsTotal`.

  `Op` stays `unknown` in the core contract and that is not changing. This is the
  middle ground: a game emitting these shapes can be driven by any client that
  understands them, and a game that does not is unaffected. Core never reads
  them, canonical and bespoke ops mix freely in one stream, and they describe
  rather than pay - `opsTotal` exists to check a presentation against the settled
  multiplier in a test, never to move money.

  **A universal client.** `UniversalClient` in `@open-rgs/client` plays a round
  to completion without being written against the game. It tries a simple spin,
  and a complex mode answering `INVALID_MODE` makes it switch to open/step/close
  rather than needing to be told which shape it is talking to. Every call carries
  a token that a retry reuses, `resumeIfUnfinished()` finishes a round the last
  session left open, and `describeRound()` renders a stable, greppable transcript
  for a test fixture, a CI log, or a bug report.

  **`open-rgs-play`.** The same runner as a command, for a server you just
  deployed: `bunx open-rgs-play ws://host/wss --rounds 20`. `--retry-token`
  sends every round with the same token and fails the run if the balance moved
  more than once, and `--abandon` / `--resume` walk the replay path end to end.
  Exit code is 1 on any failure, so it drops straight into CI as a smoke test.

### Patch Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - `UniversalClient`'s default idempotency tokens were a bare counter -
  `uc-spin-1` - which is unique only within one client's lifetime. Two clients
  on the same session inside the server's request-cache window (a reconnect, a
  rerun of a smoke test, two workers) minted identical tokens, and the server
  correctly answered the second run from the first run's cache: the run passed
  without a single round having executed. Tokens now carry a per-instance random
  prefix, while a retry inside one client still reuses its own token.
- Updated dependencies [[`1935286`](https://github.com/open-rgs/open-rgs/commit/1935286a1bbef1bc30a6b3a18216c0bde8962937), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928)]:
  - @open-rgs/contract@2.0.0

## 1.0.2

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
