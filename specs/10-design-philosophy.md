# Spec 10 — Design Philosophy

## Goal

Capture the design principles that keep open-rgs lean and rot-resistant.
This is meta-level guidance for *how* we evolve the project, not *what*
the project does.

## North star

Two words: **KISS** and **don't-rot**. Open-source projects in the
gambling-tech space have a track record of bloating, then being
abandoned, then being unforked. We avoid that by making the codebase
small, opinionated, and well-instrumented.

## Anti-rot principles

### 1 · Public surface stays tiny

Only `@open-rgs/contract` (types) and `@open-rgs/core` (runtime) are
*required*. Everything else — adapter-kit, mock-casino, CLI, Lua
loader, WASM loader, transport variants, Redis session store — lives
as opt-in peer packages.

A new maintainer can read the required surface in 30 minutes.

### 2 · Spec is source of truth

When code and spec disagree, spec wins or is updated first. PR template
asks "did you update the relevant spec?" Drift is the primary rot vector
for projects like this; we kill it by convention.

### 3 · One opinionated way per concern

No "auth helper #1 vs #2 vs #3 — pick your favourite."

- One canonical HMAC-SHA256
- One canonical JWT
- One canonical mTLS
- One canonical session store (in-memory)
- One canonical math loader (Lua via wasmoon)

If someone needs exotic, they bring their own. Optionality compounds;
pick one.

### 4 · No half-features in core

If autoclose isn't done, it's not in core. Better five solid pieces
than eight half-baked ones. (We saw this with `patchBalance` — it was
half-finished, rotted, removed.)

### 5 · Push concerns out of core

Lua loader, WASM loader, Redis session store, Prometheus metrics —
all belong as peer packages with `@open-rgs/*` namespace, not bundled
into `core`. Core stays focused on orchestration only.

### 6 · Contract changes are loud

- Adding a field is fine.
- Renaming or removing one is a major version bump (post-1.0) or at
  least a CHANGELOG entry with migration recipe (pre-1.0).
- Type tests via `expectTypeOf` (or `// @ts-expect-error` blocks)
  catch accidents.

### 7 · Acceptance criteria are testable

Every "X must Y" in a spec is a `bun:test` test. No "should be fast" —
instead "p99 spin latency < 200µs at workload X" with a measurable
benchmark.

### 8 · No PII anywhere ever

`LocalSession` type has no name/email field. Logger has a guard
refusing to log certain key patterns. Documented as a hard property.

### 9 · Every dep needs a justification

Each `npm install` is a maintenance liability. Rule: every dep added
needs a comment in `package.json` saying *why* and *what it would take
to remove*. Today we have only `@msgpack/msgpack` and `wasmoon` —
both justifiable. Stay disciplined.

### 10 · ADRs for major decisions

Short architectural decision records in `specs/adr/`. New maintainers
can read them and understand *why*. Format:

```
# ADR NNN — <title>
**Status:** Accepted | Superseded by ADR-XXX
**Date:** YYYY-MM-DD
**Context:** What problem
**Decision:** What we chose
**Consequences:** What that means
**Alternatives considered:** What we rejected and why
```

### 11 · Examples are CI-gated

Every example game runs through `@open-rgs/cli simulate` (once it
ships) on every commit. Contract changes that break an example fail
CI. Examples can't rot because they always run.

### 12 · Cull regularly

Quarterly review: anything in the codebase that nothing imports gets
removed. Dead code is rot bait.

## What we deliberately AVOID

A few things that look tempting but invite rot:

- **Plugin systems** for the orchestrator. If we genuinely need
  extensibility, peer packages with explicit hooks are better than a
  runtime plugin loader.
- **Multi-game per process.** Each game = its own Bun process (a few
  MB). The complexity of in-process multi-tenancy isn't worth what
  we save in pods.
- **Custom DSLs.** Lua is the snap-in math language. We don't invent
  our own.
- **An RPC framework.** Whatever shape adapters take, they use plain
  HTTP + plain WS. No JSON-RPC layer, no gRPC requirement.
- **A web UI in core.** Operator UI lives in mock-casino (dev) and
  operator-portal (planned, optional). Core ships JSON admin
  endpoints only.

## Approval requests pending

Decisions for the user to ratify in the next session. Each is a
specific call-to-action.

| ID | Decision | Recommendation | Status |
|----|----------|----------------|--------|
| A | Idempotency: simple `{ generate?, ttlMs? }` config | done | ✓ implemented |
| B | Math version stamping: one field name | done | ✓ implemented |
| C | Loader extraction (lua to peer package) | yes, before 1.0 | pending |
| D | ADR directory format | yes, seed with 6 records | seeded |
| E | `specs/adapters/` for per-provider notes | yes | seeded |
| F | One concurrency policy: kick-old, no knob | yes | pending impl |
| G | Math version migration: discard-and-fresh | yes | pending impl |
| H | Type tests on `@open-rgs/contract` | yes | pending |
| I | ESLint + Prettier + EditorConfig | yes | pending |
| J | Public-surface freeze plan, target v0.5 | yes | pending |

Three open architectural questions still pending:

| ID | Question | Recommendation |
|----|----------|----------------|
| A5 | Event delivery semantics | at-least-once + adapter-side dedupe by event ID |
| A6 | Partial-failure policy | bubble as `*_FAILED`; recovery on restart per manifest |
| A8 | Time semantics | `Date.now()` UTC ms; deadlines as durations; server-clock authoritative |

## Versioning policy

- **Pre-v0.5:** breaking changes allowed at minor bumps; CHANGELOG required.
- **v0.5 (proposed contract freeze):** no breaking changes to
  `@open-rgs/contract` without a deprecation cycle.
- **v1.0:** semver. Breaking changes require a major bump and a
  6-month deprecation cycle.
- **The wire protocol** (Spec 04) carries no in-frame version field; a
  schema number is exposed via `/api/manifest` for out-of-band
  negotiation.

## How to propose a change

1. Open a discussion or PR against the relevant spec file.
2. State the goal, the alternatives considered, the recommendation.
3. If the change deserves an ADR, write it.
4. Update `09-roadmap.md` if the change affects sequencing.
5. Implement after the spec lands. Reviewers check both.

## How NOT to propose a change

- "Quick fix" PRs that don't update the spec.
- New peer packages without a justification comment in the package.json.
- New deps without a "why and how to remove" comment.
- Half-finished features behind feature flags. Either ship or don't.
- Configuration knobs added "just in case." Wait for a real use case.
