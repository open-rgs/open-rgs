# CLAUDE.md — handoff context for AI sessions

This file captures state for an AI assistant resuming work on
**open-rgs**. Read this first; it points you at the right specs and
tells you what's done, what's decided, and what's pending.

## What this project is

**open-rgs** — an MIT-licensed Remote Game Server. Bun-native
orchestrator + snap-in Lua maths + pluggable platform adapters +
binary-msgpack transport. The runtime layer between casino game math
and operator wallets.

Read `README.md` for the elevator pitch. Read `specs/README.md` for
the spec corpus. Read `specs/00-overview.md` for what we're building.

## Repo layout

This is a Bun-workspaces monorepo:

```
open-rgs/
├── CLAUDE.md                  ← THIS FILE
├── README.md                  user-facing overview
├── LICENSE                    MIT
├── package.json               bun workspaces root
├── tsconfig.base.json
├── specs/                     spec corpus — READ FIRST
├── deploy/                    reference deployment templates
├── packages/
│   ├── contract/              @open-rgs/contract — types only
│   ├── core/                  @open-rgs/core — orchestrator + runtime
│   ├── log/                   @open-rgs/log — structured logger
│   ├── platform-mock/         @open-rgs/platform-mock — in-memory dev wallet
│   ├── adapter-kit/           @open-rgs/adapter-kit — helpers for adapter authors
│   ├── adapter-test-kit/      @open-rgs/adapter-test-kit — conformance suite
│   ├── client/                @open-rgs/client — tiny WS client
│   └── simulator/             @open-rgs/simulator — RTP simulator + reports
└── apps/
    └── site/                  Astro docs site → open-rgs.schmooky.dev
```

## What's shipped

- All eight `@open-rgs/*` packages
- `apps/site` — public docs site (Astro static SSG)
- Specs `00–10` + `12` + ADRs
- `deploy/` — reference Docker + k8s templates

## Working principles (KISS + don't-rot)

The user's stated north star is "make sure it won't rot since it's
MIT open source." Read `specs/10-design-philosophy.md` for the full
list. Short version:

- Keep public surface tiny (only `contract` + `core` are required)
- Spec is source of truth; code follows
- One opinionated way per concern, no plugin systems
- No half-features in core
- Push concerns out of core into peer packages
- Examples are CI-gated
- ADRs for major decisions
- Cull regularly
- Every dep needs justification

## Conventions to maintain

- TypeScript: strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
- Code style: prose comments where helpful, no ceremony where not.
- Spec edits and code edits land together in the same PR.
- `bun:test` for unit tests.
- No PII in any code path.
- All money amounts are integers in the currency's minimal unit
  (USD 1.00 → 100 when `SessionInfo.currencyDecimals = 2`).
- Math is currency-blind, RNG-injected, opaque-to-core.
- Money moves twice per round at most (open + close, or one settle).
- Autoclose is NEVER timer-driven inside RGS — always external trigger.
- Public packages have neutral examples — never name a specific
  provider's wire shape, brand, or product id in code or spec.

## Out of scope for open-rgs

These belong to the operator's gamification layer, NOT the RGS:

- Tournaments, leaderboards
- Progressive jackpots, Daily Drops
- Cashback, promotional campaigns (beyond `PromoFreeRounds` —
  granted free-rounds pool surfaced by the adapter)
- Loyalty
- Multi-currency sessions, master sessions

The RGS is a calculator that runs rounds, applies a max-win cap, and
asks the adapter to move money. That's it.

## How to resume

If a new Claude session opens this repo:

1. Read this file.
2. Read `specs/README.md` and `specs/00-overview.md`.
3. Read `specs/09-roadmap.md` for "what's next."
4. Read `specs/10-design-philosophy.md` for "how we work."

## Typecheck + tests

```bash
bun install
bun run typecheck
bun test
```
