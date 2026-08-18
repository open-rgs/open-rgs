---
"@open-rgs/client": patch
---

`UniversalClient`'s default idempotency tokens were a bare counter -
`uc-spin-1` - which is unique only within one client's lifetime. Two clients
on the same session inside the server's request-cache window (a reconnect, a
rerun of a smoke test, two workers) minted identical tokens, and the server
correctly answered the second run from the first run's cache: the run passed
without a single round having executed. Tokens now carry a per-instance random
prefix, while a retry inside one client still reuses its own token.
