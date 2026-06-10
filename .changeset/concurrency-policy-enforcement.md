---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

Enforce `ConcurrencyPolicy` at INIT - BEHAVIOR CHANGE. When a second
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
