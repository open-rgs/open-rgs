// Minimal open-rgs game. Boots an RGS with the in-memory MockPlatform
// (no external wallet needed), serves a single Lua math on a binary-
// msgpack WebSocket. Hit ws://localhost:8080/wss with @open-rgs/client.
//
// Read this file top-to-bottom for a 60-second tour of the surface.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { createServer, binaryTransport, loadLuaMath } from "@open-rgs/core";
import { defineGame } from "@open-rgs/contract";
import { MockPlatform } from "@open-rgs/platform-mock";

const here = fileURLToPath(new URL(".", import.meta.url));

// Inject the RNG that determines outcomes. open-rgs deliberately does NOT
// default to Math.random for real-money play — loadLuaMath fails closed in
// production without an rng. Here we use a crypto-backed 53-bit float in
// [0,1); a production deployment wires its certified/approved RNG instead.
function cryptoRng(): number {
  const u = new Uint32Array(2);
  webcrypto.getRandomValues(u);
  return (u[0]! * 2 ** 21 + (u[1]! >>> 11)) / 2 ** 53;
}

const math = await loadLuaMath(resolve(here, "../maths/spin.lua"), { rng: cryptoRng });

const manifest = defineGame({
  id:               "hello-spin",
  declaredRtp:      0.85,         // matches the math's `rtp` field
  defaultMode:      "default",
  maxWinMultiplier: 5000,
  modes: {
    default: { math, stakeMultiplier: 1 },
  },
});

await createServer({
  manifest,
  platform:  new MockPlatform({
    startingBalance:  100_000,   // 1000.00 in 2-decimal-currency units
    currencyDecimals: 2,
    allowedBets:      [20, 50, 100, 200, 500, 1000],
    defaultBetIndex:  2,
  }),
  transport: binaryTransport({ port: Number(process.env["PORT"] ?? 8080) }),
  version:   "0.1.0",
});

console.log("hello-spin ready on http://localhost:" + (process.env["PORT"] ?? 8080));
console.log("  WS:        ws://localhost:" + (process.env["PORT"] ?? 8080) + "/wss");
console.log("  /healthz:  http://localhost:" + (process.env["PORT"] ?? 8080) + "/healthz");
