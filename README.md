# open-rgs

A small, MIT-licensed Remote Game Server. Bun-native orchestrator,
snap-in Lua maths, pluggable wallet adapters, binary-msgpack on the
wire. One Bun file boots a working server.

Built for slots, instant games, Mines, Chicken-Road, crash, and any
other casino round shape.

**Docs:** <https://open-rgs.schmooky.dev>

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
            ┌───────────────────────────────┐
            │             CLIENT            │
            └────────────────┬──────────────┘
                             │  binary-msgpack over ws
                             ▼
            ┌───────────────────────────────┐
            │           TRANSPORT           │
            ├───────────────────────────────┤
            │         ORCHESTRATOR          │ ◀──── admin http
            │   ┌───────────────────────┐   │       /livez /healthz
            │   │   Lua math (wasmoon)  │   │       /admin/*
            │   └───────────────────────┘   │
            └────────────────┬──────────────┘
                             │  PlatformAdapter (one interface)
                             ▼
            ┌───────────────────────────────┐
            │       PLATFORM ADAPTER        │
            └────────────────┬──────────────┘
                             │  vendor wire — your call
                             ▼
                          OPERATOR
```

Four parts, each one interface in `@open-rgs/contract`. Swap any of
them without touching the others.

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

- **Slots, instant-win, dice, plinko** → simple math (single `play()` call)
- **Mines, Chicken-Road, Tower** → complex math (`open` / `step` / `close`)
- **Crash (Aviator-style)** → complex math, no STEP (single OPEN + CLOSE)
- **Gamble / pick bonus** → complex math seeded from prior win
- **Feature buys (ante, buy bonus)** → another mode in the manifest

Recipes with working code: <https://open-rgs.schmooky.dev/build>

## Extend

Plug points (each is one interface):

- **Wallet adapter** → implement `PlatformAdapter` (talks to your operator's wallet)
- **Transport** → implement `ClientTransport` (the default `binaryTransport` is binary-msgpack + WS)
- **Lua VM extensions** → `LuaExtension` for helpers (reels, paylines, distributions)
- **Metrics / logs** → bring your own registry / formatter
- **Idempotency** → configurable per RPC

Reference extension: [`@open-rgs/ext-reels`](https://github.com/open-rgs/ext-reels) — strip generation, payline evaluation, book-of utilities.

How-to recipes: <https://open-rgs.schmooky.dev/extend>

## What open-rgs does NOT do

- Tournaments, leaderboards, progressive jackpots, Daily Drops
- Cashback, promotional campaigns (beyond the granted free-rounds pool)
- Loyalty programmes
- Multi-currency sessions, master sessions
- Bonuses initiated by the math (the math returns a multiplier; nothing more)

All of the above belong to the platform's gamification layer. open-rgs
is a round calculator + wallet driver.

## Status

`v0.x` — usable and in production, but the contract may break across
minor bumps until `1.0`. Watch the GitHub releases for changelogs.

## License

MIT — see `LICENSE`.
