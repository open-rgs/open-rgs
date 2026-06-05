# Spec 00  - The Seven Guarantees

## Goal

Name the safety properties open-rgs holds **by construction**, so an
integrator can rely on them without reading the source. These are the
load-bearing promises of the engine. Everything else is detail.

Each guarantee states: the **promise**, **where** the engine enforces it,
what it **prevents**, and how an integrator must **not break it**. They are
deliberately few and deliberately named  - a reviewer should be able to point
at a change and say which guarantee it touches.

> These are guarantees, not guidelines. A change that weakens one is a
> breaking change to the engine's safety posture and must be called out as
> such. When a guarantee and convenience conflict, the guarantee wins.

---

## 1 . No Money, No Honey

**Game state is never persisted unless the money for it moved. State follows
money; it never precedes it.**

A round's cross-round state (carry: progress counters, meta-meters, gamble
pots) is written **only as part of the settle that moves the money**  - never
in a separate, earlier write. A round that is abandoned, errors, or whose bet
is declined writes **nothing**: no balance change, and no state change.

- **Enforced by:** the orchestrator computes the outcome, then makes a single
  `settleSimple` / `closeComplex` call carrying both `win` and the math's
  `carry` in one operation (`specs/05-platform-protocol.md`). Nothing is
  persisted before that call. There is no "advance the counter" code path
  separate from the money path.
- **Prevents:** *partial-state farming*  - accumulating progress (a bonus
  meter, a free-spin counter) on rounds that never financially happened. The
  classic break is writing a progress counter before the win settles; a
  crash, disconnect, or forced error between the two then leaves free progress.
- **Integrators must not:** persist carry, counters, or meters in a write that
  precedes (or is independent of) the money movement. If your adapter stores
  state, store it in the **same transaction** as the balance change. See
  [[2 . One Round, One Record]] for the reverse direction.
- **Auditable:** every money-moving round logs a named `outcomeStatus`
  (`RoundOutcomeStatus`) in the tamper-evident audit log  - `settled`,
  `settled-max-win`, `opened`, `autoclosed`, and crucially `failed-bet`: a
  declined bet logs `failed-bet` with `win = 0` and is **never** a `settled`.
  So "no money, no honey" is not just a code property, it's visible in the
  audit trail  - an auditor can confirm no phantom settle exists for a round
  whose money never moved.

## 2 . One Round, One Record

**Money and game-state are a single atomic unit. They commit together, and
they revert together  - latest-first, never from a stale snapshot.**

A round is one record: the balance delta *and* the carry it produced. A
rollback / reversal / chargeback reverses the **whole** record  - both halves  -
and only the most recent un-reversed round may be reversed.

- **Enforced by:** the settle call is atomic (one transaction in a real
  wallet). The reversal contract (`PlatformAdapter` rollback semantics,
  `specs/05-platform-protocol.md`) requires money and carry to move as one
  unit, and rejects out-of-order reversal.
- **Prevents:** *rollback farming*  - reversing the money while keeping the
  state (free progress), or keeping a payout while replaying its trigger. Also
  prevents the subtler bug where rolling back an **older** round restores a
  snapshot that predates newer rounds and silently over-refunds them.
- **Integrators must not:** reverse a balance without reversing the carry it
  was committed with, or restore an absolute pre-round snapshot of an old
  round while newer rounds sit on top of it. Reverse latest-first, whole-record.

## 3 . Blind Math

**The math never sees money.** It is a pure function of prior state and
injected randomness: `(prev_carry, rng, params) -> multiplier + ops + carry`.
No bet, no balance, no currency, no clock, no I/O.

- **Enforced by:** `SpinContext` carries only `{ mode, params }`  - never a
  bet or balance (`specs/01-public-contracts.md`). The Lua runtime is
  sandboxed: `os`, `io`, `debug`, `package`, `load*` are nil'd, and randomness
  is routed through the injected `host.rng_next` (`specs/03-math-runtime.md`).
- **Prevents:** an entire class of exploit *structurally*  - a math file
  **cannot** value a payout by a switched bet, leak through the filesystem, or
  produce a non-deterministic-but-for-RNG result, because it is never handed
  the tools. Bet-aware safety (e.g. stake-locks on deferred payouts) therefore
  lives where it belongs: in the bet-aware adapter, not the math.
- **Integrators must not:** smuggle the bet into `params` and have the math
  branch on it for payout value. Math returns a dimensionless multiplier; the
  engine multiplies by a bet the math never learns.

## 4 . The House Computes, The Client Asks

**Outcomes are server-authoritative. The client supplies intent, never
results.** Win, multiplier, RNG, and outcome are computed by the engine; the
client may only choose *which bet* and *which action*.

- **Enforced by:** the wire request types carry a bet index / price
  multiplier / action  - never a win, multiplier, seed, or outcome
  (`specs/04-wire-protocol.md`). Forced-outcome hints (`cheat`) are stripped in
  production and are never a first-class wire field
  (`specs/01-public-contracts.md`).
- **Prevents:** client-claimed wins, seed manipulation, outcome injection.
- **Integrators must not:** trust any client-supplied amount or result. Bet
  *selection* is validated against the allowed ladder; everything else is
  derived server-side.

## 5 . Fail Closed

**Under uncertainty, the engine refuses to pay rather than guessing.**

A non-finite multiplier (`NaN`/`+/-Infinity`), a win the bet can't fund, a
0-bet round that produced a win, a math file that overran its time budget, or
(in production) a missing certified RNG  - each fails the round rather than
moving money on a bad value.

- **Enforced by:** multiplier sanitization (non-finite -> hard error, negative
  -> clamp to 0), `assertFundedWin`, the math watchdog (`MATH_TIMEOUT`), and
  RNG fail-closed under `NODE_ENV=production`
  (`specs/02-orchestrator.md`, `specs/03-math-runtime.md`). The watchdog is
  per math runtime: only the Lua loader has a true execution watchdog (an in-VM
  `debug.sethook` count hook that preempts even a tight loop). WASM has none -
  `createMathPool` fails the *round* closed on a budget overrun (no bad payout,
  no hung connection) but cannot kill a tight-loop runaway thread
  (`worker.terminate()` can't preempt a sync loop), and bare `loadWasmMath` has
  no timeout at all - so WASM kernels must be trusted/bounded (a hard no-DoS
  kill needs process isolation).
- **Prevents:** a math bug becoming a *maximum* payout (the canonical
  `NaN <= cap` trap), negative settlements, and unauditable randomness in
  real-money play.
- **Integrators must not:** "rescue" a failed round by substituting a default
  win. A failed round pays nothing; see [[1 . No Money, No Honey]].

## 6 . At Most Once

**A replayed or raced request moves money at most once.**

The same logical operation  - retried after a dropped response, re-sent on
reconnect, or raced from a second connection  - settles a single time.

- **Enforced by:** per-session operation serialization in the orchestrator (at
  most one operation per session runs at a time), idempotency keys on every
  money-moving wallet call (`deriveIdempotencyKey`,
  `specs/05-platform-protocol.md`), and an optional transport-level
  operation-sequence guard that drops duplicates/rejects gaps at the socket
  (`specs/04-wire-protocol.md`).
- **Prevents:** double-spend / double-credit via replay or concurrency.
- **Integrators must not:** rely on the engine alone if your wallet is a
  separate service  - the wallet **must** dedupe on the idempotency key for the
  guarantee to hold end-to-end. The engine derives and forwards the key; the
  wallet honours it.

## 7 . Bounded Payout

**Every win is capped, and the cap is enforced by the engine  - never trusted
from the math.**

A per-mode or game-wide `maxWinMultiplier` clips any single round's win; when
it fires the outcome is stamped so the cap is visible and auditable.

- **Enforced by:** the max-win cap in the orchestrator, applied after
  multiplier sanitization and before settle, stamping
  `type = "max_win_reached"` (`specs/02-orchestrator.md`).
- **Prevents:** an unbounded or runaway multiplier draining the bankroll; most
  jurisdictions require this cap.
- **Integrators must not:** treat a math-declared cap as the enforcement point.
  The math may *describe* intent; the engine *enforces* the limit.

---

## Where each guarantee lives

| # | Guarantee | Primary enforcement | Spec |
|---|-----------|---------------------|------|
| 1 | No Money, No Honey | settle carries money+carry; nothing written before | [05](./05-platform-protocol.md) |
| 2 | One Round, One Record | atomic settle + reversal contract (latest-first, whole-record) | [05](./05-platform-protocol.md) |
| 3 | Blind Math | `SpinContext` has no money; sandboxed VM | [01](./01-public-contracts.md), [03](./03-math-runtime.md) |
| 4 | House Computes, Client Asks | request carries intent only; server computes outcome | [04](./04-wire-protocol.md) |
| 5 | Fail Closed | sanitize / funded-win / watchdog / RNG fail-closed | [02](./02-orchestrator.md), [03](./03-math-runtime.md) |
| 6 | At Most Once | per-session lock + idempotency keys + op-seq guard | [04](./04-wire-protocol.md), [05](./05-platform-protocol.md) |
| 7 | Bounded Payout | max-win cap enforced engine-side | [02](./02-orchestrator.md) |

## What this is not

These guarantees are about the **engine's** integrity surface  - that the
calculator runs rounds, conserves money, and asks the wallet to move it
safely. They are **not** a substitute for the operator's own controls:
KYC/AML, responsible-gaming limits, jurisdiction rules, and the wallet's own
ledger correctness live outside open-rgs (`CLAUDE.md` "out of scope"). open-rgs
guarantees it won't *hand* the wallet a bad instruction; the wallet still owns
its books.
