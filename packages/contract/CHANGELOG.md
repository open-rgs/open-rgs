# @open-rgs/contract

## 2.0.0

### Major Changes

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **Remove the Lua math tier.** `loadLuaMath`, `LuaExtension`, `LuaVm` and the
  `wasmoon` dependency are gone. Two tiers remain:

  - **TS** (`loadTsMath`) - you wrote the math and you run the server. Default.
  - **WASM** (`loadWasmMath`) - someone else wrote it, or you need bit-deterministic
    floats and a hashable artifact for a lab.

  Lua sat in an awkward middle and lost to WASM on every axis it was supposed to
  win. Sandboxed: WASM is too, and by construction. Certifiable: WASM ships a
  hashable artifact and bit-deterministic float ops; Lua does neither. Hot reload:
  `loadTsMath` cache-busts on content hash. And it was ~1,300x slower than the TS
  tier on identical math, which mattered not for serving - compute is rounding
  error against the wallet RPC - but for the tune loop a math author actually
  lives in.

  Removing it also deletes the `LuaExtension` plugin system entirely. That
  mechanism only existed because Lua math cannot `import`: it needed a
  registration contract, a prelude source transform, host bridging, and a rule
  that every extension be self-contained (nested tables marshal unreliably across
  the bridge). TS math just imports, so a library is an ordinary package.
  `@open-rgs/ext-reels` and `@open-rgs/ext-holdwin` are deprecated with it.

  **Migrating.** A Lua math is a near-mechanical transliteration - the twin-slot
  port was 20 lines. The one shape change is that a TS math default-exports a
  FACTORY taking the host rather than a bare object:

  ```ts
  export default (host: MathHost): SimpleMath => ({
    kind: "simple",
    name: "spin",
    version: "1.0.0",
    rtp: 0.96,
    play: () => {
      const r = host.rng_next(); /* ... */
    },
  });
  ```

  That indirection is the RNG seam Lua got from its `host` global, and
  `loadTsMath` rejects a bare-object export for exactly that reason.

  `cryptoRng` and `resolveRng` moved from the Lua loader into `core/src/rng.ts`
  and are still exported from `@open-rgs/core`.

### Minor Changes

- [#68](https://github.com/open-rgs/open-rgs/pull/68) [`1935286`](https://github.com/open-rgs/open-rgs/commit/1935286a1bbef1bc30a6b3a18216c0bde8962937) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - `SpinContext` now carries the round's `betIndex` and `priceMultiplier`.

  Math was currency-blind and also stake-blind: it could not tell a 0.10 round
  from a 10.00 one. That rules out a whole class of ordinary mechanics — a meter
  that fills in proportion to the stake, a ladder whose rungs differ per tier —
  unless the client sends its bet level in `params`, where a client that lies
  about it desyncs the mechanic from the money.

  Both fields come from `computeBet`, so they are the same numbers the wallet is
  charged against: the client's choice, the session default, or the bet a promo
  locked the round to. Currency-blindness is untouched — an index is not an
  amount, and the win is still `multiplier × bet` with `bet` owned by the
  orchestrator.

  Additive and optional: every existing math keeps compiling and behaving
  identically.

  `openComplex` now also stamps `mathVersion`, which `settleSimple` and
  `closeComplex` already did. Without it the adapter had no version to write at
  open and a round reported two different state-format versions across its own
  lifetime.

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - **REST transport.** `restTransport()` runs the same orchestrator over plain
  HTTP and JSON: one POST route per call, plus `GET /healthz`. `binaryTransport`
  stays the default - a slot is a long-lived session with many small messages -
  but REST suits a back-office tool, a smoke test, a curl in a runbook, or a
  client behind something that will not proxy WebSockets.

  It cannot push, and says so rather than pretending. `closeConnection` is
  deliberately not implemented, so `concurrencyPolicy: "kick-old"` degrades to
  `"allow"` and `createServer` warns at boot instead of silently doing nothing.
  Each response carries the current balance. There is also no connection to bind
  a session to, so the `sid` in the body is the only credential - the same token
  the launch URL carries, but leaned on harder than over WebSocket.

  **Deferred close.** `withDeferredClose(simpleMath)` lets a client finish a
  round explicitly. The outcome is still decided in one call, but the round stays
  open until the client ends it, so a player who closes the tab mid-presentation
  reconnects, replays the spin, and closes it.

  This converts the game into a complex round, and the docs say so plainly rather
  than implying a third round shape: `open` runs the simple math and parks the
  outcome, `close` pays it, and the money moves twice like any other complex
  round. An open round therefore holds an outstanding debit - `autoclose` matters
  more with this on - and `spin` is refused while one is open.

  A late close pays exactly what the open decided, and `autoclose` settles at the
  same value, so a player who never returned is not penalised and one who
  returned late is not rewarded.

  **Replay hint.** `OpenRoundResume.replay` is set when a round is open only
  because the client never finished it, carrying `unfinished: true` and the
  canonical message `"Unfinished round — watching replay"`. A client shows the
  right thing without knowing which modes defer their close.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Promote TypeScript from a prototyping convenience to the **default math tier**,
  and give it the RNG seam and purity guarantees the Lua and WASM tiers already
  had.

  `loadTsMath(path, { rng })` joins `loadLuaMath` and `loadWasmMath`. A TS math
  default-exports a **factory** (`MathFactory`) taking the host
  (`MathHost = { rng_next, log_debug }`) rather than a bare math object. That
  indirection is the point: Lua math draws through the `host` global and a WASM
  kernel imports `host.rng_next`, so neither can reach an ambient generator, while
  a bare TS module can - `Math.random()` is one identifier away, it looks correct,
  and it passes every test you would think to write while silently destroying seed
  reproducibility and voiding any RTP measured from a replay. A bare-object default
  export is now rejected.

  `loadTsMath` also runs a **purity gate** over the source before importing it,
  refusing ambient randomness (`Math.random`, `crypto`), the clock (`Date`,
  `performance.now`), I/O (`fetch`, `process`, `require`, dynamic `import`),
  dynamic escape hatches (`globalThis`, `eval`, `Function(`), and
  implementation-defined float ops (`Math.sin/cos/exp/log/pow/...`, which are not
  specified to bit precision and so would not reproduce a certified RTP across
  engine builds). Correctly-rounded ops stay allowed. Comments and quoted strings
  are stripped before scanning; template-literal holes are not. `assertPure` is
  exported so CI can gate a math file without loading it.

  This is a guardrail against accidents, **not a sandbox** - a determined author
  evades a source scan, and an imported module runs with the host's full authority.
  Math you do not control still belongs in the WASM tier.

  Measured on identical math (`examples/twin-slot`, now the same game written
  three ways, with a CI-gated three-way parity test proving byte-identical
  outcomes from the same RNG stream):

  | Tier            | per `play()` | spins / sec / core |
  | --------------- | -----------: | -----------------: |
  | Lua (wasmoon)   |    16,643 ns |             60,084 |
  | Zig -> WASM     |     1,176 ns |            850,016 |
  | TS (in-process) |        13 ns |         77,978,628 |

  ~1,300x the Lua tier and ~92x the WASM kernel. The spread is the boundary, not
  the language - in-process TS crosses nothing. It changes nothing about serving
  (compute is rounding error against the wallet RPC) and everything about
  simulation: a 1M-spin tuning run goes from 17 seconds to 13 milliseconds.

  **Replay.** `loadTsMath(path, { rngMode: "seed-expand" })` draws ONE seed per
  entry-point call and expands it deterministically, so a whole call collapses to
  a single recordable number. The returned math gains `lastSeed` (a JSON-safe
  integer below 2^53) and `withSeed(seed, fn)`; given the same seed and the same
  carry, the outcome reproduces byte for byte - on a different instance, on a
  fresh load, and after thousands of intervening spins.

  The Lua tier's contract already claimed a call was "fully reconstructable from
  its seed", but nothing ever surfaced the seed, so the property was unusable.
  With `contentHash` (which math), carry (from what state), and `lastSeed` (on
  which stream), a round is now fully reconstructable in practice.

  Note this is a REPLAY feature, not a performance one: in the Lua tier
  seed-expand mainly dodges per-draw JS<->WASM crossings, and in-process TS has no
  boundary to dodge. `isTerminal` deliberately does not reseed - it is a pure
  predicate over state, and reseeding there would shift the stream out from under
  a recorded seed. Default stays `"per-draw"`, which is unpredictable and
  unreplayable, as a CSPRNG has no seed to write down.

## 1.2.0

### Minor Changes

- [#55](https://github.com/open-rgs/open-rgs/pull/55) [`0e82986`](https://github.com/open-rgs/open-rgs/commit/0e82986fa98e82bc6bf1df8904239f454c30ad56) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Enforce `ConcurrencyPolicy` at INIT - BEHAVIOR CHANGE. When a second
  connection INITs a session already attached to another live connection, the
  orchestrator now arbitrates: **kick-old** (new default - the older
  connection gets a `SESSION_IN_USE` error frame and is closed with app close
  code 4000; the newest window always wins), **reject-new** (the newer INIT
  fails with `SESSION_IN_USE`), or **allow** (the previous coexist behaviour;
  set `createServer({ concurrencyPolicy: "allow" })` to keep it). Money was
  safe under any policy; what changes is that two open windows no longer
  silently diverge. A dropped connection detaches first, so reconnects are
  never policed. Contract: `ConcurrencyPolicy` gains `"allow"`,
  `RGSErrorCode` gains `SESSION_IN_USE`, and `ClientTransport` gains the
  optional `closeConnection` capability (a transport without it degrades
  kick-old to allow with a boot warning). New metric:
  `rgs_session_concurrency_actions_total{action}`.

### Patch Changes

- [#52](https://github.com/open-rgs/open-rgs/pull/52) [`c029ad3`](https://github.com/open-rgs/open-rgs/commit/c029ad37eb817e8b700d80c2691102e0c15a4a84) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Harden the reversal contract docs with two normative rules. `reverseRound` is
  wallet-initiated, so it arrives outside the orchestrator's per-session lock -
  adapters MUST implement it to be safe under concurrent invocation with
  settle/open/close on the same session. A real adapter MUST also persist its
  reversed-round tracking (receipts, reversed set, latest-first ordering basis)
  durably, since a restart that forgets prior reversals turns a retried reversal
  into a second credit. Docs only - no runtime changes.

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
