// End-to-end smoke: boots a real binaryTransport + orchestrator +
// MockPlatform with a hand-rolled SimpleMath, opens a real WebSocket
// from RgsClient, runs INIT + SPIN + INVALID-SPIN, asserts everything.
//
// Proves the full wire pipeline (TS → msgpack-encode → WS → orchestrator
// → msgpack-decode → TS) works end-to-end — something none of the
// per-package unit tests cover.

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createServer, binaryTransport, type ServerHandle } from "@open-rgs/core";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type SimpleMath, type GameManifest } from "@open-rgs/contract";
import { RgsClient, RgsServerError } from "../src/index.js";

const PORT = 18190;
const ADMIN_PORT = 18191;

function deterministicMath(multiplierFn: () => number): SimpleMath {
  return {
    kind: "simple",
    name: "e2e-math",
    version: "0.0.1",
    rtp: 1.0,
    contentHash: "abc123",
    play() {
      const m = multiplierFn();
      return {
        multiplier: m,
        ops: [{ kind: "test", multiplier: m }],
        type: m > 0 ? "win" : "loss",
      };
    },
  };
}

describe("e2e: client ↔ server full round-trip", () => {
  let server: ServerHandle;
  let client: RgsClient;
  let multipliers: number[];
  let mulIdx: number;

  beforeAll(async () => {
    multipliers = [2.0, 0, 5.0];
    mulIdx = 0;
    const math = deterministicMath(() => multipliers[mulIdx++ % multipliers.length]!);

    const manifest: GameManifest = defineGame({
      id: "e2e-game",
      declaredRtp: 1.0,
      defaultMode: "default",
      maxWinMultiplier: 100,
      modes: {
        default: { math, stakeMultiplier: 1, label: "E2E" },
      },
    });

    const platform = new MockPlatform({
      startingBalance: 10_000,
      currency: "USD",
      currencyDecimals: 2,
      allowedBets: [10, 50, 100, 500],
      defaultBetIndex: 2,
    });

    server = await createServer({
      manifest,
      platform,
      transport: binaryTransport({ port: PORT }),
      adminPort: ADMIN_PORT,
      installSignalHandlers: false,
    });

    client = new RgsClient(`ws://localhost:${PORT}/wss`);
    await client.connect();
  });

  afterAll(async () => {
    client.disconnect();
    await server.stop({ drainMs: 100 });
  });

  test("INIT returns balance + bet ladder", async () => {
    const init = await client.init("e2e-session");
    expect(init.sid).toBe("e2e-session");
    expect(init.balance).toBe(10_000);
    expect(init.currency).toBe("USD");
    expect(init.currencyDecimals).toBe(2);
    expect(init.allowedBets).toEqual([10, 50, 100, 500]);
    expect(init.defaultBetIndex).toBe(2);
    expect(init.modes.length).toBe(1);
    expect(init.modes[0]!.id).toBe("default");
  });

  test("SPIN debits + credits + returns ops", async () => {
    // multipliers[0] = 2.0 → bet 100, win 200, balance 10000 - 100 + 200 = 10100
    const spin = await client.spin({ betIndex: 2 });
    expect(spin.roundId).toBeTruthy();
    expect(spin.bet).toBe(100);
    expect(spin.multiplier).toBe(2);
    expect(spin.win).toBe(200);
    expect(spin.balance).toBe(10_100);
    expect(spin.type).toBe("win");
    expect(spin.ops.length).toBe(1);
  });

  test("SPIN with multiplier=0 is a clean loss", async () => {
    // multipliers[1] = 0 → bet 100, win 0, balance 10100 - 100 = 10000
    const spin = await client.spin({ betIndex: 2 });
    expect(spin.multiplier).toBe(0);
    expect(spin.win).toBe(0);
    expect(spin.balance).toBe(10_000);
    expect(spin.type).toBe("loss");
  });

  test("SPIN with multiplier=5 lands fine (under max-win 100)", async () => {
    // multipliers[2] = 5.0 → bet 100, win 500, balance 10000 - 100 + 500 = 10400
    const spin = await client.spin({ betIndex: 2 });
    expect(spin.multiplier).toBe(5);
    expect(spin.win).toBe(500);
    expect(spin.balance).toBe(10_400);
  });

  test("invalid betIndex surfaces as RgsServerError", async () => {
    let err: unknown;
    try { await client.spin({ betIndex: 99 }); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(RgsServerError);
    if (err instanceof RgsServerError) {
      expect(err.code).toBe("INVALID_BET");
    }
  });

  test("concurrent spins reject the second call", async () => {
    // Re-seed multipliers so spin completes
    multipliers.push(1);
    const a = client.spin({ betIndex: 1 });
    let err: unknown;
    try { await client.spin({ betIndex: 1 }); }
    catch (e) { err = e; }
    expect(String(err)).toMatch(/another request is in flight/);
    await a; // settle the first
  });

  test("admin /metrics shows round counts after the test spins", async () => {
    const res = await fetch(`http://localhost:${ADMIN_PORT}/metrics`);
    const text = await res.text();
    expect(text).toContain("rgs_round_total");
    expect(text).toMatch(/rgs_round_total\{[^}]*kind="simple"[^}]*\} \d+/);
    expect(text).toContain("rgs_sessions_active");
  });
});
