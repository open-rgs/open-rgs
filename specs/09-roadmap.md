# Spec 09  - Roadmap

A living document. Updated when work lands or reprioritises.
Last reality-checked against the code: 2026-06-10.

## Done (shipped in repo)

- `@open-rgs/contract`  - types-only public package, MIT.
- `@open-rgs/core`  - orchestrator, session, promo, Lua loader, binary
  transport, admin endpoints, autoclose (external-triggered),
  resume-on-reconnect.
- `@open-rgs/platform-mock`  - in-memory dev/test wallet with promo and
  autoclose helpers.
- Two example games: `lucky-digits` (simple + buyable FS) and
  `gamble-cherry` (complex round with looping gamble).
- Multi-tab drawio architecture diagrams.
- MIT license + npm-publishable metadata.
- Spec corpus 00-10 (overview through design philosophy).
- ADR seed (001-006).
- `CLAUDE.md` handoff doc for AI session continuity.
- `@open-rgs/simulator` - per-mode RTP / hit-rate simulator + reports, with
  multi-process `--shards`, plus fast batch tiers: `simulateWasmBatch`
  (in-kernel `sim_batch`, ~216M spins/s single-threaded) and
  `simulateNativeBatch` (native Zig + `std.Thread`, ~1.65B spins/s,
  byte-parity with the WASM kernel).
- WASM math loader (`loadWasmMath`) - load a Zig/Rust-authored `.wasm` kernel
  directly (simple math).
- Math worker pool (`createMathPool`) - runs WASM math in Worker threads with
  a per-call `terminate()` timeout (the fail-closed watchdog for the WASM tier).
- Secure-by-default outcome RNG (`cryptoRng` via WebCrypto -> BoringSSL) with
  production fail-closed (the operator must choose an RNG explicitly) and an
  opt-in deterministic `seed-expand` replay mode (xoshiro256++).
- Worked examples on Zig kernels (e.g. `examples/hold-and-win`).
- `open-rgs-sim` CLI (the `bin` of `@open-rgs/simulator`)  - covers the
  planned `cli simulate` role: manifest in, spins/seed/`--shards`,
  md/html/json reports (`packages/simulator/src/cli.ts`). The
  `compare` / `certify` / `fuzz` commands remain open (below).
- Prometheus metrics on `/admin/metrics` (2026-06-10; PRs #47, #49, #50)  -
  round/math/session series plus instance identity (`rgs_build_info`),
  platform SLA series (`rgs_platform_connected`,
  `rgs_platform_connection_transitions_total`,
  `rgs_platform_last_ok_timestamp_seconds`) and financial counters
  (`rgs_bets_minor_total` / `rgs_wins_minor_total` / `rgs_declared_rtp`),
  with a periodic `financial_snapshot` log line
  (`packages/core/src/metrics-rgs.ts`, `packages/core/src/server.ts`;
  specs 06/07).
- Graceful shutdown + drain mode  - `createServer` installs a SIGTERM
  handler; `stop()` stops accepting connections and drains in-flight
  requests for `shutdownDrainMs` (default 30 s) before exit
  (`packages/core/src/server.ts`).
- Reference deployment template  - `deploy/docker/` (Dockerfile +
  compose) and `deploy/k8s/` (Deployment + HPA), per spec 07.
- Idempotency keys end-to-end (core side)  - the orchestrator derives or
  generates a key for every money-moving platform call: spin/open via
  `initiatingIdemKey`, close via `deriveIdempotencyKey`
  (`packages/core/src/orchestrator.ts`). Forwarding the key onto the
  provider wire is each adapter's job by design.
- Adapter-owns-state restore  - on `openSession` the orchestrator
  rebuilds the session from `SessionInfo.carry` / `nextMode` /
  `mathVersion` and discards the carry on a math-version mismatch
  (discard-and-fresh, ADR-004; `packages/core/src/orchestrator.ts`).

## Architectural decisions captured (A1-A10)

| ID | Decision | Status |
|----|----------|--------|
| A1 | Configurable idempotency (uuid-v4 default, cuid-v2 helper) | Contract done; orchestrator wiring pending |
| A1 | RGS generates round IDs | ADR-005 |
| A1 | Player identity opaque to RGS | ADR-006 §by-construction |
| A1 | Connection ID propagated to adapter on openSession | Contract done |
| A2 | Integer minor units for amounts | ADR-002 |
| A3 | Adapter-kit ships every reasonable auth | Pending @open-rgs/adapter-kit |
| A4 | Bonus model design | Deferred until 5+ provider specs reviewed |
| A5 | Event delivery semantics | Open: recommend at-least-once + dedupe |
| A6 | Partial-failure policy | Open: recommend `*_FAILED` + recovery on restart |
| A7 | One open round, one WS connection per session | Round done; kick-old impl pending |
| A7 | Multi-pod dedup is operator's problem | ADR-006 §multi-pod |
| A8 | Time semantics | Open: recommend Date.now UTC ms, durations |
| A9 | No PII anywhere | Done by construction; logger guard pending |
| A10 | Wire schema version out-of-band | Done via /api/manifest |
| A10 | Math version stamping + discard-fresh on mismatch | Contract done; orchestrator wiring pending |

## Approval requests (Spec 10 §Approval requests)

A  - idempotency simplification: ✓ implemented
B  - math version field naming: ✓ implemented
C  - loader extraction: pending
D  - ADR directory: ✓ seeded
E  - `specs/adapters/`: pending (per-provider analyses added as real wallet specs arrive; kept brand-neutral)
F  - kick-old WS policy: pending
G  - math version migration discard-fresh: pending
H  - type tests on contract: pending
I  - ESLint/Prettier/EditorConfig: pending
J  - public-surface freeze v0.5: pending

## In-flight (work specified, partial implementation)

| Item | Spec | Status |
|------|------|--------|
| Cross-process restart recovery | 02, 05 | platform adapter inquiry endpoint TBD |
| ~~Idempotency keys end-to-end~~ (core side done) | 04, 05 | orchestrator derives/generates a key on every money-moving call; forwarding onto the provider wire is each adapter's job |
| ~~Adapter-owns-state migration~~ (done) | 04, 05 | orchestrator rebuilds sessions from SessionInfo.carry/nextMode/mathVersion (ADR-004) |
| External API surface (casino-facing) | NEW | sketched during an early provider analysis; not yet specced |
| Game launcher | NEW | sketched during an early provider analysis; not yet specced |

## Planned next 30 days

| Item | Spec | Why |
|------|------|-----|
| ~~`@open-rgs/cli simulate`~~ (covered) | 08 | `open-rgs-sim` (bin of `@open-rgs/simulator`) fills this role |
| `@open-rgs/cli compare` | 08 | Exploit smoke test for CI |
| `@open-rgs/cli certify` | 08 | Math labs need the report shape |
| ~~Reference deployment template~~ (done) | 07 | shipped under `deploy/docker` + `deploy/k8s` |
| ~~Cheat fail-closed~~ (done) | 04 | Cheat removed from the wire contract; honored only via `params.cheat` with an explicit opt-in and never in production; loud warning when enabled |
| Manifest validation: `nextMode` resolution | 01 | Catch typos at boot, not at runtime |

## Planned next 60-90 days

| Item | Spec | Notes |
|------|------|-------|
| W3C tracing | 06 | Prometheus metrics shipped 2026-06-10 (see Done); tracing remains open |
| Public/private state split (`view(state)`) | 01, 03, 08 | Required for honest exploit testing |
| Bonus engine abstraction (promo -> BonusCampaign) | 02 | Jackpots, tournaments, gamification points |
| `@open-rgs/cli fuzz` & `optimize` | 08 | Round out the math-author DX |

## Deferred / not committed

- Federated jackpots across operators (separate service, not RGS).
- Player communication primitives (achievements, missions).
- Live ops / cohort A/B testing in manifest.
- `@open-rgs/transport-json-ws`  - useful but not urgent.
- `@open-rgs/transport-rest`  - useful but not urgent.
- LuaJIT FFI loader path  - wait for benchmarks to justify the
  deployment complexity.
- Distributed simulator runs  - wait for billion-spin demand.
- Helm chart  - wait for operator pull.
- Hot reload for math files in dev  - small, cheap, low priority.

## Sequencing rationale

The order above prioritises:

1. **Math-author DX** (`simulate` / `compare` / `certify`)  - without
   the CLI, math designers can't iterate or certify, and the project
   doesn't deliver its core value.
2. **Production-readiness gaps** (cheat strip, manifest validation,
   metrics, graceful shutdown)  - the runtime is correct but operators
   would refuse to deploy without these.
3. **Architectural breadth** (WASM loader, bonus engine, public/private
   state)  - needed once we onboard the second game or the second wallet.
   (Multi-game-*per-process* is explicitly out  - one game per process;
   spec 10, "What we deliberately AVOID".)
4. **Quality-of-life** (transports, hot reload)  - improvements that
   compound but don't unblock anything urgent.

## Compatibility commitments

Pre-1.0 (`0.x.y`):
- Breaking changes to `@open-rgs/contract` are allowed at minor
  versions but are documented in the changelog.
- Breaking changes to `@open-rgs/core` internal modules
  (`orchestrator.ts`, `session.ts`, etc.) are allowed at any version.
- The wire protocol (`Spec 04`) does not break within `0.x` unless a
  versioned message-type code change is introduced (and the old codes
  remain valid for a deprecation cycle).

Post-1.0:
- Standard semver. Breaking changes to public packages require a major
  bump. The wire protocol carries a schema version for negotiation.

## How to propose a change

1. Open a discussion or PR against the relevant spec file.
2. State the goal, the alternatives considered, the recommendation.
3. Update `09-roadmap.md` if the change affects sequencing.
4. Implement after the spec lands. Reviewers will check both.
