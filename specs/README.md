# open-rgs specs

Spec-driven development for the open-source Remote Game Server. **Specs come
before implementation.** When a spec and the code disagree, the spec wins
(or the spec is updated first, then the code).

## How to use

- Read **00-guarantees.md** first for the safety properties you can rely on.
- Read **00-overview.md** next for the system in one screen.
- Read **01-public-contracts.md** for the four interfaces every integrator
  cares about.
- Pick the spec for the area you're working on.
- When you propose a change that touches a spec'd area, update the spec
  alongside the implementation. Reviewers will check both.

## Index

| #  | Spec | Status | Owner |
|----|------|--------|-------|
| 00 | [The Seven Guarantees](./00-guarantees.md)  - the safety properties open-rgs holds **by construction** (read first) | living | core |
| 00 | [Overview](./00-overview.md)  - what we're building, who for | draft | core |
| 01 | [Public Contracts](./01-public-contracts.md)  - MathModule, PlatformAdapter, ClientTransport, GameManifest | draft | core |
| 02 | [Orchestrator](./02-orchestrator.md)  - round flows, sessions, promo, autoclose | draft | core |
| 03 | [Math Runtime](./03-math-runtime.md)  - Lua via wasmoon, Zig->WASM, RNG seam | draft | runtime |
| 04 | [Wire Protocol](./04-wire-protocol.md)  - binary-msgpack frames, error codes | draft | transport |
| 05 | [Wallet Protocol](./05-platform-protocol.md)  - canonical operations, error vocab | draft | wallet |
| 06 | [Performance](./06-performance.md)  - Bun + Zig, latency budgets, throughput | draft | perf |
| 07 | [Deployment](./07-deployment.md)  - math bundling, Docker, K8s, env vars | draft | ops |
| 08 | [Testing & Certification](./08-testing.md)  - simulator, fuzzer, RTP reports | draft | qa |
| 09 | [Roadmap](./09-roadmap.md)  - done, in-flight, deferred, sequencing | living | core |
| 10 | [Design Philosophy](./10-design-philosophy.md)  - KISS + anti-rot principles | living | core |
| 12 | [Adapter Cookbook](./12-adapter-cookbook.md)  - step-by-step guide to writing a PlatformAdapter | living | core |

## Sub-corpora

- [adr/](./adr/)  - Architectural Decision Records (six seeded: Bun
  runtime, integer minor units, external autoclose, adapter owns
  state, RGS-generated round IDs, stateless RGS).
- `adapters/`  - reserved for per-provider analysis as real wallet /
  external-API specs arrive (none committed yet; examples must stay
  neutral, so any entry describes a generic wallet shape, not a named
  provider's wire protocol).

## Spec template

Each spec follows the same shape:

```
# Spec NN  - <area>

## Goal

One paragraph. What does this part of the system do, and why?

## Non-goals

What this spec does NOT cover. Scope clarity.

## Inputs / outputs

What flows in, what flows out, in canonical types.

## Constraints

Performance budgets, compatibility guarantees, security requirements,
regulatory considerations.

## Design

The minimum viable description. Diagrams welcome (link to drawio tabs).

## Acceptance criteria

Concrete, testable. "X happens, Y is observable, in Z time budget."

## Open questions

Things we know we don't know. Decisions deferred with reasons.
```

## Conventions

- **TypeScript signatures** are the source of truth for interfaces. The
  `@open-rgs/contract` package mirrors what's spec'd here. If they diverge,
  open an issue and align.
- **Error codes** are the canonical `RGSErrorCode` enum. Adding one is
  spec-affecting; removing one is a breaking change.
- **Performance budgets** are stated in microseconds for hot paths and
  milliseconds for end-to-end. Numbers are measured, not aspirational.
- **"Math" always means a single math module** (a `.lua`, `.wasm`, or
  `.ts` file implementing the contract). A "game" is the manifest that
  composes maths into modes.
