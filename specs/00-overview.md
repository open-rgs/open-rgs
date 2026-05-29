# Spec 00 — Overview

## Goal

open-rgs is an MIT-licensed Remote Game Server: the runtime layer between a
casino game's math and the operator's wallet. It is a thin, fast,
language-agnostic orchestrator. Math files are written once and run
identically across operators because the wallet protocol is abstracted
behind one interface. The same server image ships with whichever set of
math files a deployment cares about.

## Why this exists

Existing RGS implementations are either (a) closed, per-vendor systems
that lock studios into one operator's protocol, or (b) bespoke
per-studio rewrites that duplicate the same orchestration logic over and
over. Neither offers a clean math contract that math designers can
target without learning a vendor's framework.

open-rgs separates three concerns that have historically been tangled:

- **Game math** — paytables, weights, RTP, feature triggers. Written by
  math designers, certified by math labs, owned by studios.
- **Wallet integration** — Hello/Welcome handshakes, op_seq counters,
  audit logs, promo payloads. Operator-specific.
- **Orchestration** — session caching, mode resolution, bet computation,
  round lifecycle, observability. Universal.

This project owns the third. The first two plug in.

## Audience

- **Math designers** writing `.lua` (or `.wasm`) game files.
- **Studios** assembling games from one or more math files into a
  deployable server.
- **Wallet integrators** writing one `PlatformAdapter` per operator.
- **Operators** running the resulting servers in their infrastructure.
- **Math labs** running simulations against math files for certification.

## Scope

### In scope

- A round-lifecycle orchestrator (simple + complex rounds).
- Pluggable platform adapters via `PlatformAdapter`.
- Pluggable client transports via `ClientTransport`.
- Snap-in math modules via `MathModule`, default runtime Lua-on-wasmoon.
- A reference binary-MessagePack WS transport.
- Free-round promo handling driven by wallet events.
- External-triggered autoclose (no in-process timers).
- Resume-on-reconnect with full action history.
- Admin/observability endpoints (`/livez`, `/healthz`, `/logs`,
  `/api/sessions`, `/api/manifest`, `/api/modes`, `/api/autoclose`).
- Demo mode (no real wallet).
- Dev-only cheat hints.
- A reference deployment template (Docker, env-var contract).

### Out of scope

- Wallet implementations themselves (each operator writes their own).
- Game UI/client rendering.
- Player identity, KYC, AML, GDPR — these belong upstream of the wallet.
- Funds movement / cashier — also upstream.
- Persistent storage of any kind. The wallet is the source of truth.
- Game-specific math (we ship examples; real math is per-studio).
- Cross-operator promotional tooling (jackpots, tournaments) — those
  live above the RGS.

## Architecture in one sentence

A Bun process loads a `GameManifest` (modes → math files), instantiates a
`PlatformAdapter` for the upstream operator, and exposes a `ClientTransport`
to the player; per-spin it routes mode → math, computes bet from the
manifest, settles via the wallet, and emits ops to the client.

See `docs/architecture.drawio` for the colour-coded diagrams (six tabs).

## Non-goals worth being explicit about

- We do not pursue "framework neutrality" in the orchestrator runtime.
  Bun is the chosen runtime. PRs to make it run on Node, Deno, or
  workers are not accepted unless they preserve the hot-path performance
  profile spec'd in `06-performance.md`.
- We do not provide a turnkey audit/compliance solution. The wallet's
  audit trail is the regulatory record. RGS-side logs are operational.
- We do not couple the math contract to any particular language. Lua is
  the default loader because the embedding cost is near-zero; Zig→WASM,
  Rust→WASM, AssemblyScript and TypeScript-in-process are all valid
  alternatives implementing the same `MathModule` shape.

## What "MIT-published" means here

- Repository on GitHub, public.
- `@open-rgs/contract`, `@open-rgs/core`, `@open-rgs/platform-mock` (and
  future `@open-rgs/cli`, transports, etc.) published to npm under the
  MIT license.
- Reference example examples (`lucky-digits`, `gamble-cherry`) live in
  `examples/` and are MIT.
- Reference deployment template (`deploy/`) is MIT.
- Math files written by third parties are NOT MIT by association — each
  studio's math is whatever license they choose. The orchestrator
  doesn't impose anything on what runs on top of it.

## Versioning policy

- Pre-1.0 (`0.x.y`): minor versions may break the contract. Pin exact
  versions and read the changelog.
- Post-1.0: semver. Breaking changes to `@open-rgs/contract` go through
  a deprecation cycle of at least one minor version with a `/legacy`
  sub-export.

## Repository layout

```
open-rgs/
├── LICENSE                    MIT
├── README.md                  entry point
├── specs/                     this directory
├── docs/                      architecture diagrams + supporting prose
├── packages/
│   ├── contract/              @open-rgs/contract — types only
│   ├── core/                  @open-rgs/core — runtime
│   ├── platform-mock/           @open-rgs/platform-mock — dev/test wallet
│   └── cli/                   @open-rgs/cli — simulator/fuzzer (planned)
├── examples/
│   ├── lucky-digits/          example: simple round + buyable FS
│   └── gamble-cherry/         example: complex round with gamble
└── deploy/
    ├── docker/                reference Dockerfile + compose
    └── k8s/                   reference K8s manifests
```
