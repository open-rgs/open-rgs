---
"@open-rgs/contract": minor
"@open-rgs/core": minor
---

Add an opt-in transport replay guard  - Guarantee 6 ("At Most Once") enforced at
the socket, so replay-safety no longer depends solely on the wallet deduping.

Enable with `binaryTransport({ replayGuard: true })`. Each request then carries a
per-connection monotonically increasing integer under the reserved key `$seq`
(`WIRE_OPSEQ_KEY`, new export from `@open-rgs/contract`). The transport processes
`last+1`, **replays the cached response** for an exact re-send of `last` (a
dropped-response retry -> no re-run, no double settle), and **rejects** a gap or a
missing/non-integer sequence.

Off by default and fully backward-compatible: a client that doesn't stamp `$seq`
is unaffected. `PING` is exempt. Mirrors the operation-sequence dedup a
production wallet gateway runs at its own socket. Spec: `specs/04-wire-protocol.md`.
