---
"@open-rgs/core": patch
---

An INIT that the wallet refuses now says why.

`platform.openSession` was the one platform call `init` did not run through
`translate()`, so an upstream refusal arrived as a bare `Error`, became
`INTERNAL_ERROR` at the transport, and reached the client as
`internal error (ref: …)`. A session the wallet does not recognise is the
single most common integration failure and it was also the least legible one -
the actual reason was visible only in the pod's logs.

It maps like every other platform call now: a wallet saying `SessionInvalid`
produces `SESSION_INVALID` with the reason intact, and anything unrecognised
still fails closed as `INIT_FAILED`.
