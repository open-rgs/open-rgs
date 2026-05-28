# hello-spin

Minimal open-rgs game. One Lua math, MockPlatform wallet, binary-msgpack
on the wire. ~50 lines of code; boots in ~50 ms.

## Run

From this directory:

```bash
bun install
bun run dev
```

Then:

```bash
curl http://localhost:8080/healthz
# {"status":"ok","core_version":"0.5.0","game_version":"0.1.0",...}
```

To drive a spin, use [`@open-rgs/client`](https://www.npmjs.com/package/@open-rgs/client):

```ts
import { RgsClient } from "@open-rgs/client";
const c = new RgsClient("ws://localhost:8080/wss");
await c.connect();
await c.init({ sid: "demo" });
const r = await c.spin({});
console.log(r);  // { roundId, ops, balance, bet, win, multiplier, type }
```

## What's in this example

| File | Purpose |
|---|---|
| `src/index.ts` | One file  - boots `createServer` with `MockPlatform` + binary transport |
| `maths/spin.lua` | One file  - returns multiplier + ops per spin |
| `package.json` | Three deps: `core`, `contract`, `platform-mock` |
| `tsconfig.json` | Inherits the workspace strict config |

## What's NOT in this example

- Real wallet adapter (use `MockPlatform` for dev; implement
  `PlatformAdapter` for a real platform)
- Reel-based math (this is a single-roll RNG; use the
  [`@open-rgs/ext-reels`](https://github.com/open-rgs/ext-reels)
  extension for strip + payline + book-of helpers)
- Complex rounds (Mines, Chicken-Road, crash)  - see the docs at
  <https://open-rgs.schmooky.dev/build>
- Promo free-rounds, autoclose, FRC offers (supported by core; not
  exercised here)

## Next steps

- Read [`apps/site` docs](https://open-rgs.schmooky.dev) for the full
  picture
- Run the `@open-rgs/simulator` against `maths/spin.lua` to validate
  RTP and hit rate
- Swap `MockPlatform` for your own `PlatformAdapter` implementation
  when you're ready to face a real wallet
