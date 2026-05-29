# Spec 09 — Roadmap

A living document. Updated when work lands or reprioritises.

## Done (shipped in repo)

- `@open-rgs/contract` — types-only public package, MIT.
- `@open-rgs/core` — orchestrator, session, FRC, Lua loader, binary
  transport, admin endpoints, autoclose (external-triggered),
  resume-on-reconnect.
- `@open-rgs/platform-mock` — in-memory dev/test wallet with FRC and
  autoclose helpers.
- Two example games: `lucky-digits` (simple + buyable FS) and
  `gamble-cherry` (complex round with looping gamble).
- Multi-tab drawio architecture diagrams.
- MIT license + npm-publishable metadata.
- Spec corpus 00–10 (overview through design philosophy).
- ADR seed (001–006).
- First per-provider analysis: `specs/adapters/pgsoft.md`.
- `CLAUDE.md` handoff doc for AI session continuity.

## Architectural decisions captured (A1–A10)

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

A — idempotency simplification: ✓ implemented
B — math version field naming: ✓ implemented
C — loader extraction: pending
D — ADR directory: ✓ seeded
E — `specs/adapters/`: ✓ seeded with PG Soft
F — kick-old WS policy: pending
G — math version migration discard-fresh: pending
H — type tests on contract: pending
I — ESLint/Prettier/EditorConfig: pending
J — public-surface freeze v0.5: pending

## In-flight (work specified, partial implementation)

| Item | Spec | Status |
|------|------|--------|
| Multi-game per process | 02 | scaffolding; orchestrator path-routing TODO |
| Cross-process restart recovery | 02, 05 | platform adapter inquiry endpoint TBD |
| Idempotency keys end-to-end | 04, 05 | contract done; orchestrator + adapter wiring pending |
| Adapter-owns-state migration | 04, 05 | contract done; orchestrator reads from SessionInfo.carry pending |
| External API surface (casino-facing) | NEW | designed in pgsoft.md analysis; not yet specced |
| Game launcher | NEW | designed in pgsoft.md analysis; not yet specced |

## Planned next 30 days

| Item | Spec | Why |
|------|------|-----|
| `@open-rgs/cli simulate` | 08 | Math designers blocked without it |
| `@open-rgs/cli compare` | 08 | Exploit smoke test for CI |
| `@open-rgs/cli certify` | 08 | Math labs need the report shape |
| Reference deployment template | 07 | Ship Dockerfile + K8s manifests under `deploy/` |
| ~~Cheat fail-closed~~ (done) | 04 | Cheat removed from the wire contract; honored only via `params.cheat` with an explicit opt-in and never in production; loud warning when enabled |
| Manifest validation: `nextMode` resolution | 01 | Catch typos at boot, not at runtime |

## Planned next 60-90 days

| Item | Spec | Notes |
|------|------|-------|
| Prometheus metrics + W3C tracing | 06 | Operating blind today |
| Graceful shutdown + drain mode | 02, 07 | K8s rolling restarts drop sessions |
| WASM math loader | 03 | Open the door for Zig-authored maths |
| Public/private state split (`view(state)`) | 01, 03, 08 | Required for honest exploit testing |
| Bonus engine abstraction (FRC → BonusCampaign) | 02 | Jackpots, tournaments, gamification points |
| `@open-rgs/cli fuzz` & `optimize` | 08 | Round out the math-author DX |

## Deferred / not committed

- Federated jackpots across operators (separate service, not RGS).
- Player communication primitives (achievements, missions).
- Live ops / cohort A/B testing in manifest.
- `@open-rgs/transport-json-ws` — useful but not urgent.
- `@open-rgs/transport-rest` — useful but not urgent.
- LuaJIT FFI loader path — wait for benchmarks to justify the
  deployment complexity.
- Distributed simulator runs — wait for billion-spin demand.
- Helm chart — wait for operator pull.
- Hot reload for math files in dev — small, cheap, low priority.

## Sequencing rationale

The order above prioritises:

1. **Math-author DX** (`simulate` / `compare` / `certify`) — without
   the CLI, math designers can't iterate or certify, and the project
   doesn't deliver its core value.
2. **Production-readiness gaps** (cheat strip, manifest validation,
   metrics, graceful shutdown) — the runtime is correct but operators
   would refuse to deploy without these.
3. **Architectural breadth** (WASM loader, bonus engine, multi-game,
   public/private state) — needed once we onboard the second game or
   the second wallet.
4. **Quality-of-life** (transports, hot reload) — improvements that
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
