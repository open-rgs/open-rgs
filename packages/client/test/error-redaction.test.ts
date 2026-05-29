// M11 — internal error detail (a Lua runtime error with a file path, an
// upstream wallet body) must not reach the client. The transport returns a
// generic message + the correlation id; the detail is logged server-side.

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createServer, binaryTransport, type ServerHandle } from "@open-rgs/core";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type SimpleMath, type GameManifest } from "@open-rgs/contract";
import { RgsClient, RgsServerError } from "../src/index.js";

const PORT = 18195;
const SECRET_DETAIL = "[lua:/srv/secret/spin.lua]:42: boom internal stack detail";

const throwingMath: SimpleMath = {
  kind: "simple", name: "boom", version: "1", rtp: 1,
  play() { throw new Error(SECRET_DETAIL); },
};

describe("client never sees internal error detail (M11)", () => {
  let server: ServerHandle;
  let client: RgsClient;

  beforeAll(async () => {
    const manifest: GameManifest = defineGame({
      id: "m11-game", declaredRtp: 1, defaultMode: "default",
      modes: { default: { math: throwingMath, stakeMultiplier: 1 } },
    });
    const platform = new MockPlatform({ startingBalance: 10_000, currency: "USD", currencyDecimals: 2, allowedBets: [100], defaultBetIndex: 0 });
    server = await createServer({ manifest, platform, transport: binaryTransport({ port: PORT }), installSignalHandlers: false });
    client = new RgsClient(`ws://localhost:${PORT}/wss`);
    await client.connect();
  });
  afterAll(async () => { client.disconnect(); await server.stop({ drainMs: 50 }); });

  test("a math exception surfaces as a generic INTERNAL_ERROR, not the leaky detail", async () => {
    await client.init("m11-session");
    let err: unknown;
    try { await client.spin({ betIndex: 0 }); }
    catch (e) { err = e; }

    expect(err).toBeInstanceOf(RgsServerError);
    const se = err as RgsServerError;
    expect(se.code).toBe("INTERNAL_ERROR");
    // The leaky detail must NOT be in the client-facing message.
    expect(se.message).not.toContain("secret");
    expect(se.message).not.toContain("spin.lua");
    expect(se.message).not.toContain("stack");
    // It IS a generic, correlation-tagged message.
    expect(se.message.toLowerCase()).toContain("internal error");
  });
});
