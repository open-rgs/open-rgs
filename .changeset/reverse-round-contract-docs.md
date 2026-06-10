---
"@open-rgs/contract": patch
---

Harden the reversal contract docs with two normative rules. `reverseRound` is
wallet-initiated, so it arrives outside the orchestrator's per-session lock  -
adapters MUST implement it to be safe under concurrent invocation with
settle/open/close on the same session. A real adapter MUST also persist its
reversed-round tracking (receipts, reversed set, latest-first ordering basis)
durably, since a restart that forgets prior reversals turns a retried reversal
into a second credit. Docs only  - no runtime changes.
