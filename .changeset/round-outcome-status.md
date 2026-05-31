---
"@open-rgs/core": minor
---

Stamp a named `RoundOutcomeStatus` on every audit event, making Guarantee 1
("No Money, No Honey") auditable. The engine's verdict on the money  - `settled`,
`settled-max-win`, `opened`, `autoclosed`, `failed-bet`, `failed-win`,
`rejected`  - is recorded independently of the math's free-form `type`, mirroring
the status lifecycle a production wallet keeps.

The load-bearing case: a **declined bet now logs `failed-bet` with `win = 0`**
(in the settle and open failure paths) and is **never** recorded as `settled`  -
so an auditor can confirm no phantom settlement exists for a round whose money
never moved.

`outcomeStatus` is optional on `AuditInput` and defaults to `settled` when
omitted, so hand-built audit inputs and the hash chain stay backward-compatible
(the field is appended at the tail of the hashed tuple). New export:
`RoundOutcomeStatus`. Specs: `00-guarantees.md` (Guarantee 1).
