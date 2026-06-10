# Architectural Decision Records

Short, durable records of major architectural decisions. Each ADR
captures *what* was decided, *why*, and *what alternatives were
rejected*  - so future maintainers (and AI sessions) can understand the
reasoning without re-litigating it.

## Format

```
# ADR NNN  - <title>

**Status:** Accepted | Superseded by ADR-XXX
**Date:** YYYY-MM-DD

## Context
What problem we're solving and what's relevant about the situation.

## Decision
What we chose to do.

## Consequences
What that decision means  - both upsides and ongoing costs.

## Alternatives considered
What else we looked at and why we didn't pick it.
```

Keep ADRs short. ~100 lines is plenty. If you need more, you're
probably writing a spec instead.

## Index

| # | Title | Status |
|---|-------|--------|
| 001 | [Bun runtime, not Node](./001-bun-runtime.md) | Accepted |
| 002 | [Integer minor units for amounts](./002-integer-minor-units.md) | Accepted |
| 003 | [External-triggered autoclose, no in-process timers](./003-external-autoclose.md) | Accepted |
| 004 | [Adapter owns state, RGS is pass-through](./004-adapter-owns-state.md) | Accepted |
| 005 | [RGS generates round IDs](./005-rgs-generated-round-id.md) | Accepted |
| 006 | [RGS is stateless modulo session cache](./006-stateless-rgs.md) | Accepted |
| 007 | [Cross-pod resume via wallet-returned open round](./007-cross-pod-resume.md) | Accepted |

## When to write an ADR

Write one when:
- A decision will be hard to reverse.
- A decision constrains how other parts of the system must behave.
- A decision is non-obvious and a future maintainer might ask "why?"
- A decision rejects an alternative someone else might propose.

Don't write one for:
- Style choices.
- Refactors that don't change behavior.
- Decisions you're not sure about yet  - write a spec instead.
