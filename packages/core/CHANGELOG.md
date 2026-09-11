# @open-rgs/core

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

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Fixes from a full audit of the engine. Four of these were reproduced by
  running them, not by reading them.

  **A free-round pool now drains.** The contract says the engine counts the
  pool down locally. It did not: the only write to `remaining` came from an
  optional field on the receipt, so against a wallet whose wire has no promo
  echo an accepted pool of three free rounds was a pool of unlimited free
  rounds. A funded round decrements here; a wallet that reports its own number
  still wins.

  **A failed win credit is now in the audit log.** `failed-win` and `rejected`
  were defined in `RoundOutcomeStatus` and never written, so a wallet that took
  the stake at open and failed the credit at close left an `opened` event with
  no terminal event - indistinguishable from a round still in flight. Both are
  recorded now, including on the autoclose path.

  **Both transports disclose the same thing.** The binary transport genericised
  the error codes that wrap upstream detail; REST returned them verbatim, so an
  internal wallet URL reached the client over one wire and not the other. The
  policy moved to `error-policy.ts` and both call it. `clientMessage`,
  `isOpaque` and `OPAQUE_ERROR_CODES` are exported.

  **Wire payloads are validated, not cast.** `sid` becomes a session key and a
  wallet argument, `params` is handed to the math; neither was ever checked to
  be the type it was declared as. Both transports now run `validateRequest`
  first, rejecting with `INVALID_FORMAT`.

  **REST no longer locks a player out.** Its connection id was minted per
  request, so every call looked like a new connection on a bound session and
  `concurrencyPolicy: "reject-new"` refused everything after the first, forever.
  The id derives from the session id now.

  **The math is every file it is made of.** `loadTsMath` read, scanned and
  hashed the entry file only, so an impure helper module passed the purity gate
  and a rewritten payout table produced an identical `contentHash` - the value
  the audit log carries as proof of which math computed an outcome. The loader
  walks the local module graph now. It also warns when a reload cannot take
  effect, rather than silently running cached helpers. `collectMathSources` and
  `hashMathSources` are exported.

  **Seed-expand replays the round it recorded.** The stream, the seed and the
  forced-seed override were shared by every call, so two concurrent rounds drew
  from a spliced stream and the recorded seed replayed neither. State is now
  per call, held across awaits; `runSeeded(fn)` returns the seed with the call
  it belongs to.

  Also: the active-session gauge is derived from the session store rather than
  accumulated (it counted every reconnect as a new session); metric label keys
  are unambiguous and `Counter.snapshot()` exposes the label map directly;
  `/admin/sessions` returns a summary instead of every session's carry and round
  logs; the math pool sheds instead of queueing without bound; audit chains
  carry a `chainId`; the request cache is cleared on eviction and keyed so two
  sessions cannot collide; and `applyMaxWinCap` is exported so other tools can
  agree with the engine about what a round pays.

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

### Patch Changes

- [#68](https://github.com/open-rgs/open-rgs/pull/68) [`1935286`](https://github.com/open-rgs/open-rgs/commit/1935286a1bbef1bc30a6b3a18216c0bde8962937) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Two fixes on the complex-round path, both found by driving it end to end.

  **Forced outcomes never reached a complex round.** `openRound` passed
  `undefined` where `spin` passes `params.cheat`, so the dev-only cheat gate
  silently did nothing on the one round shape where a deterministic opening draw
  matters most - everything after the open is a branch off it. Same plumbing as
  `spin` now; the production gate is untouched (cheats still require an explicit
  opt-in and a non-production build).

  **`binaryTransport` reported the configured port, not the bound one.**
  `port: 0` means "bind anywhere", and the 0 was handed straight back to the
  caller and written to the listen log. Report `server.port`, which is the only
  case where the answer was not already known.

- [#68](https://github.com/open-rgs/open-rgs/pull/68) [`1935286`](https://github.com/open-rgs/open-rgs/commit/1935286a1bbef1bc30a6b3a18216c0bde8962937) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - An INIT that the wallet refuses now says why.

  `platform.openSession` was the one platform call `init` did not run through
  `translate()`, so an upstream refusal arrived as a bare `Error`, became
  `INTERNAL_ERROR` at the transport, and reached the client as
  `internal error (ref: …)`. A session the wallet does not recognise is the
  single most common integration failure and it was also the least legible one -
  the actual reason was visible only in the pod's logs.

  It maps like every other platform call now: a wallet saying `SessionInvalid`
  produces `SESSION_INVALID` with the reason intact, and anything unrecognised
  still fails closed as `INIT_FAILED`.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: remove every remaining reference to the Lua tier and simplify the prose
  around it.

  Spec 03 loses its Lua runtime section, its sandbox denylist and the wasmoon
  boundary discussion; spec 06 loses the Lua latency and throughput rows and the
  LuaJIT-via-FFI open questions. The site's `/extend` page had a whole section on
  `LuaExtension` - a registration contract, a prelude source transform, host
  bridging - which is replaced by three lines saying a library is an ordinary
  import. Package and example READMEs, the JSON-LD `programmingLanguage`, and the
  error-redaction fixtures all follow.

  Also fixed on the way through: three stale links to `@open-rgs/ext-reels`, now
  pointing at the slot libraries at `/extension`.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: every library route now carries three animatics and a syntax-coloured
  code sample, and a new `/extension/build-a-slot` walks the whole set end to end
  in eight steps.

  62 animatics across 46 distinct kinds, up from 13. Each shows the idea a page
  turns on rather than repeating the prose: the fifth cell that exists in a tall
  reel and not a short one, a pointer landing in weighted bands, a wild counted in
  both clusters it touches, a respin counter resetting rather than decrementing.

  Colouring is a small regex tokeniser rather than a highlighter dependency -
  these samples are short and TypeScript-only, and shipping a highlighter to
  colour twenty lines is not a trade worth making.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs fixes.

  The syntax highlighter corrupted its own output. It ran one regex per token
  type over the result of the last, so the string rule matched the `"c-com"`
  inside a span the comment rule had just inserted, and readers saw
  `<span class=<span class="c-str">"c-com"</span>>//` as literal text. Rewritten
  as a single pass with alternation, so inserted markup is never re-scanned.

  Comments are gone from every code sample. The prose beside a sample already
  says what it does, and a comment repeating that is noise in a block meant to be
  read at a glance.

  The multiways animatic showed all its configurations at once. Its frame classes
  were `f1`, `f2`, `f3`, which already carry the hold-and-win fill delays defined
  later in the same stylesheet; the later rule won, every frame got a delay under
  half a second, and they fired together. Renamed to `mwq1`..`mwq10` and extended
  to ten configurations on a twelve-second loop, one visible at a time.

  Arrow glyphs removed from the pages this work added: back links now read
  "All extensions", and two animatics use words where they used arrows.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: `/extension` now has one route per library rather than a single page.
  Each carries a short lede, a looped animatic of the rule that is easiest to get
  wrong, one paragraph of why, and its API surface.

  The animatics are a reusable `Anim.astro` component - square divs, no rounded
  corners, CSS keyframes only, no script, and `prefers-reduced-motion` stops them.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: library routes are now a sequence of worked examples rather than a block
  of demos above a block of text. Each example is a heading, a paragraph, the
  animatic that shows what the paragraph said, and the code that does it.

  Three examples per package, 48 across the set.

  The multiways animatic was also wrong. It grew and shrank whole columns, which
  read as artefacting and misrepresented the mechanic: a multiways board keeps the
  same height however many symbols a reel holds, and the symbols resize to fill
  it. It now cross-fades three real configurations - 2-3-4, 5-2-6 and 3-7-3 - with
  the ways count beside each.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: new `/libs` page covering the `@open-rgs/*` slot libraries - the three
  signatures every piece shares, what each layer settles, and how to extend it.
  Kept deliberately short: the animatics carry the lessons, so the prose beside
  them is a sentence or two rather than a paragraph.

  Includes four looped CSS animatics for the rules that are easy to state and
  easy to implement wrongly: cascade gravity being per-column, stickiness moving
  clumping without moving frequency, a wild belonging to every cluster it
  touches, and a hold-and-win landing resetting the respin counter rather than
  decrementing it. Square divs, no rounded corners, no external library - CSS
  keyframes are what looped div animation is for, and they respect
  `prefers-reduced-motion`.

- [#62](https://github.com/open-rgs/open-rgs/pull/62) [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Docs: a `/retries` page covering request-level idempotency, the canonical op
  vocabulary and the universal client, with six animatics.

  Two fixes found while writing it. The site's global `.bar` class (the footer)
  collided with `Anim.astro`'s `.bar`, and its `align-items: baseline` silently
  collapsed every animated gauge to zero height - the weighted-band and
  scatter-count animatics had been rendering as empty boxes. The component's
  class is now `.gauge`, with a note explaining why it must not reuse a global
  name. And `sitemap.xml` is derived from the pages on disk instead of a
  hand-kept list, which had gone stale: `/rest` and all sixteen `/extension/*`
  routes were missing from it.

  Also corrected a claim left over from the Lua removal. Guarantee 3 in
  `specs/00-guarantees.md` said the TypeScript runtime nils `os`, `io`, `debug`,
  `package` and `load*` - Lua vocabulary, and untrue of TypeScript math. It now
  describes the purity gate accurately and states plainly that it is a source
  scan rather than a sandbox: it catches the accident, not the adversary, and
  math files are code you ship.

- Updated dependencies [[`1935286`](https://github.com/open-rgs/open-rgs/commit/1935286a1bbef1bc30a6b3a18216c0bde8962937), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928), [`4c5ae7b`](https://github.com/open-rgs/open-rgs/commit/4c5ae7bcccb62321c66f38a40cd46ed506834928)]:
  - @open-rgs/contract@2.0.0

## 1.7.0

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

- [#56](https://github.com/open-rgs/open-rgs/pull/56) [`0610a95`](https://github.com/open-rgs/open-rgs/commit/0610a952316e1acb14ace43a513e7f483e3ed087) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Document the scope of the opt-in transport replay guard: it is per-connection
  by design. A reconnect (same or different pod) starts a fresh `$seq` space with
  an empty response cache; the wallet's idempotency-key dedupe (Spec 05) is the
  cross-connection at-most-once guard. Docs/jsdoc only - no behavior change.
- Updated dependencies [[`0e82986`](https://github.com/open-rgs/open-rgs/commit/0e82986fa98e82bc6bf1df8904239f454c30ad56), [`c029ad3`](https://github.com/open-rgs/open-rgs/commit/c029ad37eb817e8b700d80c2691102e0c15a4a84)]:
  - @open-rgs/contract@1.2.0

## 1.6.0

### Minor Changes

- [#50](https://github.com/open-rgs/open-rgs/pull/50) [`76d665e`](https://github.com/open-rgs/open-rgs/commit/76d665e9dc2e993ac1e5c0a7e453ea73c773777e) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Financial metrics, aggregated in-process. New counters in the currency's
  minor unit - `rgs_bets_minor_total{currency,mode,funding}` (funding=real is
  the actual debit, funding=promo the notional free-round bet) and
  `rgs_wins_minor_total{currency,mode,funding}` - plus `rgs_declared_rtp{mode}`
  as the theoretical target line. GGR and live RTP are derived at query time
  from the counters (the only way ratios aggregate correctly across a fleet).
  Each instance also emits a `financial_snapshot` log line on an interval
  (`financialLogIntervalMs`, default 10 min, 0 disables) with lifetime
  per-currency bets/wins/GGR/RTP read straight from the in-memory counters.
  `Counter` gains a `snapshot()` read-back method; bring-your-own RgsMetrics
  implementations gain three required members (`betsMinor`, `winsMinor`,
  `declaredRtp`).

- [#47](https://github.com/open-rgs/open-rgs/pull/47) [`6392421`](https://github.com/open-rgs/open-rgs/commit/63924212a973f5b7e4a602295879e5acb04cfcb6) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Instance identity + platform SLA metrics. Every server now resolves a unique
  instance id at boot (config `instanceId` > `OPEN_RGS_INSTANCE_ID` env > a
  self-generated `rgs-<8 hex>`), surfaced as `rgs_build_info{instance_id,...}`
  on /admin/metrics, `instance_id` in /healthz, and `service.instance.id` on
  every log line - per-instance metrics, logs, and health correlate on one key.
  New platform-adapter SLA series: `rgs_platform_connected` (gauge),
  `rgs_platform_connection_transitions_total{direction}` (flap counter), and
  `rgs_platform_last_ok_timestamp_seconds` (last successful wallet RPC - alert
  on its age to catch a connected-but-silent platform). Note for bring-your-own
  `RgsMetrics` implementations: the interface gains four required members
  (`buildInfo`, `platformConnected`, `platformTransitions`, `platformLastOk`).

### Patch Changes

- [#49](https://github.com/open-rgs/open-rgs/pull/49) [`fd4c9a7`](https://github.com/open-rgs/open-rgs/commit/fd4c9a749ab2bff56dfc48f6f1a69595d139603f) Thanks [@igaming-bulochka](https://github.com/igaming-bulochka)! - Baseline `rgs_platform_last_ok_timestamp_seconds` to boot time so an
  instance that has not yet served a round reads as "silent since boot"
  rather than "silent since the Unix epoch" in `time() - x` alert
  expressions.

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
