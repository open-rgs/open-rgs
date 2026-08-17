---
"@open-rgs/contract": minor
"@open-rgs/core": minor
"@open-rgs/client": minor
---

**Request-level idempotency.** A resent `spin`, `openRound`, `stepRound` or
`closeRound` carrying the same client token now returns the first call's result
without running the round again. On by default; `createServer({ requestCache:
false })` restores the previous behaviour, and `{ ttlMs, max }` tunes it.

open-rgs already derived a stable idempotency key for the wallet, but that
guarantee depends on the wallet honouring it, and some wallet protocols have no
field to carry the key at all - `@open-rgs/adapter-artube` is the worked
example. Against those, a client retry after a timeout ran the math a second
time and moved money a second time. The cache closes that on our side.

The entry is created before the work starts, so a repeat arriving *while* the
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
