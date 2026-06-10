# Security Policy

open-rgs moves real money for a living. We treat integrity bugs with
the same severity as remote-code-execution bugs.

## Reporting a vulnerability

Report privately via **GitHub Security Advisories** on this repo:
*Security -> Report a vulnerability*. Do **not** open a public issue
for anything exploitable.

- We acknowledge reports within **72 hours**.
- We aim for coordinated disclosure within **90 days** of the report
  (sooner when a fix ships sooner). We'll credit you in the advisory
  unless you prefer otherwise.

## Supported versions

The **latest published minor** of each `@open-rgs/*` package receives
security fixes. No backports  - upgrade to the current release.

## Scope: the Seven Guarantees are security properties

The Seven Guarantees ([specs/00-guarantees.md](specs/00-guarantees.md))
are the engine's safety surface. A **reproducible violation of any of
them is a security bug**, not a regular bug  - report it privately:

1. **No Money, No Honey**  - game state never persists unless the money
   for it moved.
2. **One Round, One Record**  - money and game-state commit together
   and revert together, latest-first.
3. **Blind Math**  - the math never sees bet, balance, currency, clock,
   or I/O.
4. **The House Computes, The Client Asks**  - outcomes are
   server-authoritative; the client supplies intent, never results.
5. **Fail Closed**  - under uncertainty the engine refuses to pay
   rather than guessing.
6. **At Most Once**  - a replayed or raced request moves money at most
   once.
7. **Bounded Payout**  - every win is capped, and the engine enforces
   the cap.

Concretely: a double-settle, a payout above the max-win cap, math code
escaping its sandbox, forging or splicing the tamper-evident audit
chain, a client-supplied outcome being honoured  - all security bugs.

## Out of scope

- **DoS via the documented WASM watchdog caveat.** `loadWasmMath` has
  no per-call timeout by design; WASM kernels must be trusted and
  bounded ([specs/03-math-runtime.md](specs/03-math-runtime.md)).
  Demonstrating that a hostile kernel can hang a deployment is the
  documented behaviour, not a finding.
- Issues that require an already-compromised operator or admin token.
- Vulnerabilities in consumer game code or platform adapters that live
  outside this repo  - report those to their authors.

## Supply chain

npm publishes use **OIDC Trusted Publishing with provenance**  - every
`@open-rgs/*` release is built by the repo's release workflow and
carries a signed attestation. There are **no long-lived npm tokens**
to steal. See [PUBLISHING.md](PUBLISHING.md).
