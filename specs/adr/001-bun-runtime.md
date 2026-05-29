# ADR 001 — Bun runtime, not Node

**Status:** Accepted
**Date:** 2026-05-08

## Context

We need a JavaScript/TypeScript runtime for the orchestrator. The
realistic options at the time of decision: Node, Bun, Deno. The
orchestrator is I/O-heavy (WebSockets to clients, RPC to the wallet)
with hot-path compute (math invocation via wasmoon) and needs fast
cold-start for K8s rolling restarts.

## Decision

Use **Bun** as the canonical runtime.

## Consequences

**Upsides:**

- `Bun.serve` (uWebSockets-backed) handles 10K+ concurrent WS per
  process trivially.
- Direct `.ts` execution — no transpile step, no `tsx`, no
  `ts-node`.
- `bun:ffi` available for native interop (LuaJIT, certified RNG, etc.)
  without writing a binding gen.
- Built-in `bun:sqlite`, `bun:test`, `Bun.file` reduce dep surface.
- Cold start on the order of 100ms.
- One toolchain for build, test, package management.

**Costs:**

- Smaller community than Node. Some npm packages don't work; we
  pick deps that do.
- Bun is younger; some APIs are still stabilizing. We pin to a
  minimum version and document it.
- Not every CI provider has a Bun runner; some require manual
  install in the workflow.
- Code that uses Bun-specific APIs is not Node-compatible. We're
  fine with that — Node compatibility is not a goal.

## Distribution / packaging (consequence of "Bun, not Node")

Because Bun runs `.ts` directly, the published packages follow suit —
this is deliberate, not an oversight:

- **Packages publish raw `.ts`, no `dist/`.** `main`, `types`, and
  `exports` all point at `src/*.ts`; the `files` allowlist ships `src`.
  There is no compile/bundle step, so there's no `dist` to drift from
  source, no sourcemap dance, and the published code is the code you
  read. The cost is that a **consumer must run Bun** (or a TS-aware
  loader) — importing `@open-rgs/core` from plain `node` won't resolve
  the `.ts` entry. That's the intended audience.
- **CLIs are `bunx`-only.** `@open-rgs/simulator` (`open-rgs-sim`) and
  `@open-rgs/adapter-test-kit` (`open-rgs-adapter-conform`) declare a
  `.ts` `bin` with a `#!/usr/bin/env bun` shebang. They are meant to be
  run with `bunx open-rgs-sim …`, **not** `npm install -g` on a
  Node-only box (npm would create a shim that execs `bun`, which fails
  if Bun isn't installed). Documented in each package's README.
- **The requirement is declared, not just prose.** Every publishable
  package sets `engines.bun` (`>=1.0.0`), so `bun install` enforces it
  and the constraint is machine-readable for consumers.

If Node consumption is ever required, the fix is a build step that emits
`dist/*.js` + `.d.ts` and dual `exports` — explicitly out of scope today.

## Alternatives considered

- **Node.js** — works, mature, well-known, but slower WS, slower
  cold-start, requires transpile step in dev. The throughput delta
  vs Bun is real and worth the trade-off.
- **Deno** — clean stdlib but the npm-compat story is more friction
  than Bun, and the WS performance is roughly Node-equivalent.
- **Native (Zig/Rust)** — overkill for the orchestrator; the math
  hot-path can use Zig→WASM as a peer concern (see Spec 06). The
  glue layer benefits from a high-iteration language.
