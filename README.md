# open-rgs

A small, MIT-licensed Remote Game Server. Bun-native orchestrator,
snap-in Lua maths, pluggable wallet adapters, binary-msgpack on the
wire. One Bun file boots a working server.

Built for slots, instant games, Mines, Chicken-Road, crash, and any
other casino round shape.

**Docs:** <https://open-rgs.dev>

## Install

```bash
bun add @open-rgs/core @open-rgs/contract @open-rgs/platform-mock
```

## Hello, spin

```ts
import { createServer, binaryTransport, loadLuaMath } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";
import { MockPlatform } from "@open-rgs/platform-mock";

await createServer({
  manifest: defineGame({
    id:          "hello-spin",
    declaredRtp: 0.95,
    defaultMode: "default",
    modes: {
      default: { math: await loadLuaMath("./maths/spin.lua"), stakeMultiplier: 1 },
    },
  }),
  platform:  new MockPlatform({ startingBalance: 100_000 }),
  transport: binaryTransport({ port: 80 }),
});
```

A minimal Lua math (`maths/spin.lua`):

```lua
return {
  kind = "simple", name = "spin", version = "0.1.0", rtp = 0.95,
  play = function(prev, ctx)
    local r = host.rng_next()
    local m = (r < 0.30 and 0.5) or (r < 0.40 and 2) or (r < 0.41 and 50) or 0
    return {
      multiplier = m,
      ops        = { { kind = "result", multiplier = m } },
      type       = m > 0 and "win" or "loss",
    }
  end,
}
```

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
            |   |   Lua math (wasmoon)  |   |       /admin/*
            |   +-----------------------+   |
            +----------------+--------------+
                             |  PlatformAdapter (one interface)
                             v
            +-------------------------------+
            |       PLATFORM ADAPTER        |
            +----------------+--------------+
                             |  vendor wire  - your call
                             v
                          OPERATOR
```

Four parts, each one interface in `@open-rgs/contract`. Swap any of
them without touching the others.

## The Seven Guarantees

open-rgs holds seven safety properties **by construction**  - so you can rely
on them without reading the source. They're enforced under the hood, in core,
not left to each game or adapter author to get right.

1. **No Money, No Honey**  - game state is never persisted unless the money for
   it moved. A round that's abandoned or whose bet is declined writes nothing.
2. **One Round, One Record**  - money and game-state commit together and revert
   together (latest-first, whole-record). No rollback farming.
3. **Blind Math**  - the math never sees the bet, balance, clock, or I/O. It's a
   pure `(state, rng) -> outcome`. Bet-switch exploits are impossible by design.
4. **The House Computes, The Client Asks**  - outcomes are server-authoritative;
   the client supplies only which bet and which action, never a win or seed.
5. **Fail Closed**  - under uncertainty (NaN multiplier, unfunded win, missing
   certified RNG in prod) the engine refuses to pay rather than guessing.
6. **At Most Once**  - a replayed or raced request moves money at most once.
7. **Bounded Payout**  - every win is capped, and the cap is enforced by the
   engine, never trusted from the math.

Full detail  - what enforces each, what it prevents, and how an integrator must
not break it  - in **[specs/00-guarantees.md](specs/00-guarantees.md)**.

## Packages

| Package | Purpose |
|---|---|
| `@open-rgs/contract` | types only, zero deps |
| `@open-rgs/core` | orchestrator, Lua runtime, binary-msgpack transport, admin, metrics |
| `@open-rgs/log` | structured logger (JSON / Server-core / Console formats) |
| `@open-rgs/platform-mock` | in-memory dev wallet with promo + autoclose helpers |
| `@open-rgs/adapter-kit` | WS / HTTP RPC helpers + currency conversion for adapter authors |
| `@open-rgs/adapter-test-kit` | conformance suite for any PlatformAdapter implementation |
| `@open-rgs/client` | tiny TS WebSocket client (Bun / Node / browser) |
| `@open-rgs/simulator` | per-mode RTP / hit-rate / mark simulator + reports |

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
- **Transport** -> implement `ClientTransport` (the default `binaryTransport` is binary-msgpack + WS)
- **Lua VM extensions** -> `LuaExtension` for helpers (reels, paylines, distributions)
- **Metrics / logs** -> bring your own registry / formatter
- **Idempotency** -> configurable per RPC

Reference extension: [`@open-rgs/ext-reels`](https://github.com/open-rgs/ext-reels)  - strip generation, payline evaluation, book-of utilities.

How-to recipes: <https://open-rgs.dev/extend>

## What open-rgs does NOT do

- Tournaments, leaderboards, progressive jackpots, Daily Drops
- Cashback, promotional campaigns (beyond the granted free-rounds pool)
- Loyalty programmes
- Multi-currency sessions, master sessions
- Bonuses initiated by the math (the math returns a multiplier; nothing more)

All of the above belong to the platform's gamification layer. open-rgs
is a round calculator + wallet driver.

## Status

`v1.0.0`  - the first stable release, following a full
production-readiness audit. The public contract (`@open-rgs/contract`
+ `@open-rgs/core`) follows semver from 1.0: a breaking change means a
major bump, not a surprise. Releases and per-package changelogs are
managed with [Changesets](https://github.com/changesets/changesets)  -
watch the GitHub releases.

## License

MIT  - see `LICENSE`.
