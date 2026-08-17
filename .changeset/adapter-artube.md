---
"@open-rgs/adapter-artube": minor
---

Open-source the Artube platform adapter as `@open-rgs/adapter-artube`, MIT,
published from this monorepo. It was previously restricted and published to a
private registry; the restriction has been lifted.

Nothing operator-specific is baked into the source: endpoint, game id and auth
token all come from configuration, and there are no URLs, keys or identifiers
in the code.

It now runs `@open-rgs/adapter-test-kit`, which was a declared devDependency of
the package for its whole life and had never once been executed. Doing so found
one real limitation, now documented rather than discovered at integration time:

- **`idempotencyKey` is dropped.** `PlayRoundRequest` has no idempotency field,
  so a retried settle after a timeout or reconnect is not deduplicated
  wallet-side. Mitigate by reconciliation until the protocol grows one.

It also surfaced that the wire is amount-blind - `bet_index` and
`price_multiplier`, never a money amount. That is deliberate and protective
rather than a gap: it is open-rgs's own currency-blind-math rule pushed out to
the wire, so an RGS that cannot state a monetary value cannot mis-state one.
The README says so, and notes that the wallet's ladder is authoritative and
must be read from `openSession` rather than assumed.

Complex rounds remain unsupported, and throw rather than silently no-oping.

The two conformance checks the wire cannot express are allowlisted with their
reason, and a second test asserts they are still failing, so the allowlist goes
red rather than quietly over-permitting if the wire or the test kit changes.
