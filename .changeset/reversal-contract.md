---
"@open-rgs/contract": minor
"@open-rgs/platform-mock": minor
---

Add an optional `PlatformAdapter.reverseRound` for wallet-initiated reversal
(chargeback / reconciliation), formalizing Guarantee 2  - "One Round, One
Record" (`specs/00-guarantees.md`).

A reversal MUST undo **both** halves of a round atomically  - the balance delta
AND the carry it produced  - and is **latest-first**: only the most recent
un-reversed round may be reversed, so reversing an older round can't restore a
stale snapshot and silently over-refund the newer rounds on top of it. An
unknown or already-reversed round is a safe no-op (`reversed: false`), never a
double credit.

- `@open-rgs/contract`: new optional method `reverseRound?(req: ReverseRound):
  Promise<ReverseReceipt>` plus the `ReverseRound` / `ReverseReceipt` types.
  Additive and optional  - existing adapters compile and run unchanged.
- `@open-rgs/platform-mock`: the reference wallet now implements `reverseRound`
  correctly (per-session LIFO stack of pre-round balance+carry snapshots) and
  persists carry on settle so the whole-record property is real. The
  `safety.test.ts` suite proves whole-record reversal, out-of-order rejection,
  no-double-credit, and complex-round reversal.

Spec: `specs/05-platform-protocol.md` gains a "Reversal" subsection.
