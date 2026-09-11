---
"@open-rgs/core": patch
---

Two fixes on the complex-round path, both found by driving it end to end.

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
