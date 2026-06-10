---
"@open-rgs/adapter-test-kit": minor
---

Opt-in concurrency certification: `runConformance(adapter, { concurrency:
true })` (CLI `--concurrency`) adds four checks for the surface the
orchestrator's per-session lock does NOT shield an adapter from. Parallel
settles across distinct sessions must conserve each session's balance; the
same idempotencyKey fired twice CONCURRENTLY (an in-flight duplicate, not
the sequential retry the existing dedupe check covers) must settle exactly
once with one receipt; concurrent reversals of two stacked rounds must stay
latest-first per the contract's CONCURRENCY rule on `reverseRound`  - both
legal serializations accepted, over-refund and double-credit failed  - with
a clean skip when the adapter doesn't implement the optional `reverseRound`;
and a plain sequential settle must still reconcile after the storms. Off by
default (reported as skips, like skipComplex) because the checks open
derived sessions and assume independent balances  - mock/sandbox wallets
only. Validated against the reference @open-rgs/platform-mock, plus a
deliberately racy adapter (read-then-write dedupe gap) the new duplicate
check flags where the sequential one passes it.
