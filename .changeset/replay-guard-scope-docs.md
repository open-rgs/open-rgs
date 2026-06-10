---
"@open-rgs/core": patch
---

Document the scope of the opt-in transport replay guard: it is per-connection
by design. A reconnect (same or different pod) starts a fresh `$seq` space with
an empty response cache; the wallet's idempotency-key dedupe (Spec 05) is the
cross-connection at-most-once guard. Docs/jsdoc only  - no behavior change.
