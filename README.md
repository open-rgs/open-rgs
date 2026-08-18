# open-rgs

A small, MIT-licensed Remote Game Server. Bun-native orchestrator,
snap-in maths (TypeScript, or compiled WASM kernels in Zig/Rust),
pluggable wallet adapters, binary-msgpack on the wire. One Bun file boots
a working server.

Built for slots, instant games, Mines, Chicken-Road, crash, and any
other casino round shape.

**Docs:** <https://open-rgs.dev>

## Install

```bash
bun add @open-rgs/core @open-rgs/contract @open-rgs/platform-mock
```

## Hello, spin

```ts
import { createServer, binaryTransport, loadTsMath } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";
import { MockPlatform } from "@open-rgs/platform-mock";

await createServer({
  manifest: defineGame({
    id:          "hello-spin",
    declaredRtp: 0.95,
    defaultMode: "default",
    modes: {
      default: { math: await loadTsMath("./maths/spin.ts"), stakeMultiplier: 1 },
    },
  }),
  platform:  new MockPlatform({ startingBalance: 100_000 }),
  transport: binaryTransport({ port: 8080 }),
});
```

A minimal math (`maths/spin.ts`). Note it exports a **factory** taking the
host - that is the RNG seam, and it is why math can never reach an ambient
generator:

```ts
import type { MathHost, SimpleMath } from "@open-rgs/contract";

export default (host: MathHost): SimpleMath => ({
  kind: "simple", name: "spin", version: "0.1.0", rtp: 0.95,
  play: () => {
    const r = host.rng_next();
    const m = r < 0.30 ? 0.5 : r < 0.40 ? 2 : r < 0.41 ? 50 : 0;
    return {
      multiplier: m,
      ops: [{ kind: "result", multiplier: m }],
      type: m > 0 ? "win" : "loss",
    };
  },
});
```

### Which math tier?

Two tiers. Both return the same `MathModule` and the orchestrator cannot tell
them apart.

| Tier | Reach for it when |
|------|-------------------|
| **TypeScript** (`loadTsMath`) | Default. Fastest to iterate, best tooling, purity-gated at load. |
| **Zig / Rust -> WASM** (`loadWasmMath`) | Math you do not control: sandboxed by construction, bit-deterministic floats, a hashable artifact a lab can certify. |

**On the speed difference.** In-process TypeScript calls nothing across a
boundary; a WASM kernel round-trips MessagePack through linear memory once per
call. On a deliberately trivial math - one RNG draw and a four-branch ladder,
`bun examples/twin-slot/src/bench.ts` - that boundary is the whole measurement:
roughly 12 ns per call against roughly 1,200 ns, a 100x ratio.

Read that as the cost of the boundary, not as the throughput of a game. A real
slot does thousands of operations per spin, so the fixed crossing shrinks
against the work and the ratio narrows. It makes no difference at all to
serving, where compute is rounding error against the wallet RPC; it makes a
visible difference to a million-spin tuning sweep, which is the reason the
default is the in-process tier.

TypeScript math is checked for purity at load: no `Math.random`, no clock, no I/O, no
implementation-defined float ops. See
[spec 03](./specs/03-math-runtime.md#the-purity-gate).

## Architecture (60-second tour)

```
            +-------------------------------+
            |             CLIENT            |
            +----------------+--------------+
                             |  binary-msgpack over ws
                             v
            +-------------------------------+
            |           TRANSPORT           |
            +-------------------------------+
            |         ORCHESTRATOR          | ◀---- admin http
            |   +-----------------------+   |       /livez /healthz
            |   |    TS / WASM math     |   |       /admin/*
            |   +-----------------------+   |
            +----------------+--------------+
                             |  PlatformAdapter (one interface)
                             v
            +-------------------------------+
            |       PLATFORM ADAPTER        |
            +----------------+--------------+
                             |  vendor wire, your call
                             v
                          OPERATOR
```

Four parts, each one interface in `@open-rgs/contract`. Swap any of
them without touching the others.

## The Seven Guarantees

open-rgs holds seven safety properties **by construction**, so you can rely
on them without reading the source. They're enforced under the hood, in core,
not left to each game or adapter author to get right.

1. **No Money, No Honey**: game state is never persisted unless the money for
   it moved. A round that's abandoned or whose bet is declined writes nothing.
2. **One Round, One Record**: money and game-state commit together and revert
   together (latest-first, whole-record). No rollback farming.
3. **Blind Math**: the math never sees the bet, balance, clock, or I/O. It's a
   pure `(state, rng) -> outcome`. Bet-switch exploits are impossible by design.
4. **The House Computes, The Client Asks**: outcomes are server-authoritative;
   the client supplies only which bet and which action, never a win or seed.
5. **Fail Closed**: under uncertainty (NaN multiplier, unfunded win, missing
   certified RNG in prod) the engine refuses to pay rather than guessing.
6. **At Most Once**: a replayed or raced request moves money at most once.
7. **Bounded Payout**: every win is capped, and the cap is enforced by the
   engine, never trusted from the math.

**[specs/00-guarantees.md](specs/00-guarantees.md)** has the full detail: what
enforces each guarantee, what it prevents, and how an integrator must not break it.

## Packages

| Package | Purpose |
|---|---|
| `@open-rgs/contract` | types only, zero deps |
| `@open-rgs/core` | orchestrator, TypeScript + WASM math runtimes, math worker pool, secure RNG, binary-msgpack and REST transports, admin, metrics |
| `@open-rgs/log` | structured logger (JSON / Server-core / Console formats) |
| `@open-rgs/platform-mock` | in-memory dev wallet with promo + autoclose helpers |
| `@open-rgs/adapter-kit` | WS / HTTP RPC helpers + currency conversion for adapter authors |
| `@open-rgs/adapter-test-kit` | conformance suite for any PlatformAdapter implementation |
| `@open-rgs/client` | tiny TS WebSocket client (Bun / Node / browser) |
| `@open-rgs/simulator` | per-mode RTP / hit-rate / mark simulator + reports; fast WASM & native-Zig batch tiers |
| **slot libraries** | one small package per mechanic, each an ordinary import ([all of them](https://open-rgs.dev/extension)) |
| `grid` `weights` `selectors` | the substrate: shape, weighted draws, cell selection |
| `fill` `markov` `recipes` `strips` | making a board: per-cell draws, clumping, declared mixtures, classic reels |
| `paytable` `pay-lines` `pay-ways` `pay-anywhere` `pay-cluster` | what a board is worth |
| `multiways` `big-symbols` `scatters` `symbols` | reel heights, blocks, spawned scatters, symbol mechanics |
| `cascade` `holdwin` `freespins` `picks` `gamble` `meters` | features: tumbles, respins, free spins, pick bonuses, gambles, collection meters |

## Build a game

The math file changes per game shape; the boot file stays the same:

- **Slots, instant-win, dice, plinko** -> simple math (single `play()` call)
- **Mines, Chicken-Road, Tower** -> complex math (`open` / `step` / `close`)
- **Crash (Aviator-style)** -> complex math, no STEP (single OPEN + CLOSE)
- **Gamble / pick bonus** -> complex math seeded from prior win
- **Feature buys (ante, buy bonus)** -> another mode in the manifest

Recipes with working code: <https://open-rgs.dev/build>

## Extend

Plug points (each is one interface):

- **Wallet adapter** -> implement `PlatformAdapter` (talks to your operator's wallet)
- **Transport** -> implement `ClientTransport`. Two ship: `binaryTransport` (binary-msgpack over WebSocket, the default) and `restTransport` (plain HTTP and JSON, for tooling and clients that cannot hold a socket open)
- **Deferred close** -> wrap a simple math with `withDeferredClose` so the client finishes the round explicitly, and an abandoned round can be replayed and closed later
- **Math** -> `loadTsMath` (default) or `loadWasmMath`; both return the same `MathModule`
- **Slot libraries** -> 19 packages from `@open-rgs/grid` to `@open-rgs/freespins`, imported like any package
- **Compiled math** -> ship a WASM kernel (`loadWasmMath`) authored in Zig/Rust; run it fail-closed under a worker pool (`createMathPool`)
- **Metrics / logs** -> bring your own registry / formatter
- **Idempotency** -> configurable per RPC

See [open-rgs.dev/extension](https://open-rgs.dev/extension) for the library set.

How-to recipes: <https://open-rgs.dev/extend>

## What open-rgs leaves to the platform

- Tournaments, leaderboards, progressive jackpots, Daily Drops
- Cashback, promotional campaigns (beyond the granted free-rounds pool)
- Loyalty programmes
- Multi-currency sessions, master sessions
- Bonuses initiated by the math (the math returns a multiplier; nothing more)

These belong to the platform's gamification layer. open-rgs is a round
calculator and a wallet driver.

## Status

`v1.x` is stable, following a full production-readiness audit. The public contract (`@open-rgs/contract`
+ `@open-rgs/core`) follows semver from 1.0: a breaking change means a
major bump, not a surprise. Releases and per-package changelogs are
managed with [Changesets](https://github.com/changesets/changesets); watch
the GitHub releases.

## License

MIT. See `LICENSE`.
