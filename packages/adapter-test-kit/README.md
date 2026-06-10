# @open-rgs/adapter-test-kit

Conformance test suite for `PlatformAdapter` implementations. Hand it
any adapter; get back a checklist of what works.

## Runtime

**Bun is required** (`engines.bun >= 1.0.0`). This package publishes raw
TypeScript (no `dist/`) and the `open-rgs-adapter-conform` `bin` is a
`.ts` file with a `#!/usr/bin/env bun` shebang, so run it with **`bunx`**
 - not `npm install -g` on a Node-only machine. See ADR-001 for why.

## CLI

```bash
bunx open-rgs-adapter-conform \
  --adapter '@your-org/wallet-adapter' \
  --export MyAdapter \
  --opts '{"gameId":"example-game","wsUrl":"wss://wallet.example.com/ws"}' \
  --out-md ./conform.md
```

Required: `--adapter <module>` (npm package or path) and `--export <name>`
(adapter class export, default `default`). Optional: `--opts <json>` (or
env `ADAPTER_OPTS_JSON`), `--skip-complex`, `--skip-events`,
`--concurrency`, `--timeout-ms <n>`, `--out-json <path>`. Exit code is 0
only if every non-skipped check is `ok`.

## Use (as a library)

```ts
import { runConformance, mdConformanceReport } from "@open-rgs/adapter-test-kit";
import { MyAdapter } from "./adapter";

const adapter = new MyAdapter({ ...creds });
const report = await runConformance(adapter);

console.log(mdConformanceReport(report));
// -> # Conformance  - my-adapter @ 0.1.0
//   18 ok . 0 warn . 0 fail . 2 skip (20 total, 312ms)
//   ...

if (report.summary.fail > 0) process.exit(1);   // fail your CI
```

## What it checks

| Group       | What                                                              |
|-------------|-------------------------------------------------------------------|
| lifecycle   | connect / isHealthy / diagnostics shape / disconnect              |
| session     | openSession returns a SessionInfo with the required fields        |
| simple-round | settleSimple (zero-win + with-win), debits + credits balance     |
| complex-round | openComplex -> updateComplex (optional) -> closeComplex            |
| events      | adapter emits at least one event; balanceChanged shape is valid   |
| concurrency | opt-in (`concurrency: true`): parallel cross-session settles conserve per-session balances; the same idempotencyKey fired twice concurrently settles exactly once; concurrent reversals stay latest-first (no over-refund); a plain settle still reconciles afterwards |

Each check returns one of `ok | warn | fail | skip` with a one-line
message on non-ok.

## Coverage knobs

```ts
runConformance(adapter, {
  fixture: { bet: 250, betIndex: 3 },   // override the session shape
  skipComplex: true,                    // platform is simple-rounds-only
  skipEvents: true,                     // platform doesn't push events
  concurrency: true,                    // opt IN to the concurrency checks
});
```

`concurrency: true` is opt-in (reported as skips otherwise) because the
checks open derived sessions (`<sessionId>-conc-*`) and assume each maps
to an independent balance  - true for a mock or sandboxed wallet, which is
the only thing this suite should ever point at. The reversal-interleave
check runs only when the adapter implements the optional `reverseRound`;
it skips cleanly otherwise.

## What it doesn't do

- It doesn't load-test. For that, write a separate harness.
- It doesn't verify real-money correctness  - bring your own mock or a
  sandboxed credentials path. The kit assumes calls are safe to make
  back-to-back without disturbing production data.
- It doesn't replace `bun:test` for adapter-specific cases. Conformance
  is the floor; add adapter-specific tests for the bits the contract
  doesn't constrain.

## Test

```bash
bun install
bun test    # in-test adapters + the reference @open-rgs/platform-mock
```
