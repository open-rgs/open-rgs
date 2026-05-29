// H2  - the wire protocol mandates a 1 MiB frame ceiling (Spec 04), but the
// transport enforced none in either direction: a client could send
// arbitrarily large frames (memory/DoS). This boots the real transport and
// asserts an oversized inbound frame closes the connection instead of being
// decoded.

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { binaryTransport, MAX_FRAME_BYTES, type BinaryClientTransport } from "../src/transport-binary.js";
import type { OrchestratorAPI } from "@open-rgs/contract";

const PORT = 18293;

// The orchestrator is never reached for an oversized frame  - Bun rejects it
// at the WS layer  - so a throwing stub is fine.
const stubApi = {
  init: async () => { throw new Error("unreached"); },
  spin: async () => { throw new Error("unreached"); },
  openRound: async () => { throw new Error("unreached"); },
  stepRound: async () => { throw new Error("unreached"); },
  closeRound: async () => { throw new Error("unreached"); },
  promoAccept: async () => { throw new Error("unreached"); },
  autocloseRound: async () => ({ closed: false }),
  onDisconnect: () => {},
} as unknown as OrchestratorAPI;

describe("transport frame-size cap (H2)", () => {
  let transport: BinaryClientTransport;

  beforeAll(async () => {
    transport = binaryTransport({ port: PORT });
    await transport.start(stubApi);
  });
  afterAll(async () => { await transport.stop({ drainMs: 10 }); });

  test("MAX_FRAME_BYTES is the spec's 1 MiB", () => {
    expect(MAX_FRAME_BYTES).toBe(1024 * 1024);
  });

  test("an oversized inbound frame closes the connection (not decoded)", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/wss`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error before open")));
    });

    const closed = new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });

    // 2 MiB binary frame  - over the 1 MiB cap.
    ws.send(new Uint8Array(MAX_FRAME_BYTES + MAX_FRAME_BYTES));

    const code = await Promise.race([
      closed,
      new Promise<number>((_, rej) => setTimeout(() => rej(new Error("no close within 2s")), 2000)),
    ]);
    // The oversized frame is rejected and the connection closed  - Bun reports
    // 1009 (message too big) or 1006 (abnormal) to the client depending on
    // version. The point is it closed rather than decoding a 2 MiB payload.
    expect([1009, 1006]).toContain(code);
  });

  test("a normal small frame keeps the connection open", async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/wss`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("ws error before open")));
    });
    let earlyClose = false;
    ws.addEventListener("close", () => { earlyClose = true; });
    // A tiny (well-formed-ish) frame: type byte + small msgpack map. The stub
    // throws, which the transport maps to an error frame  - but the socket
    // stays open (no size-based close).
    ws.send(new Uint8Array([0x03, 0x80])); // 0x80 = msgpack empty map
    await new Promise((r) => setTimeout(r, 150));
    expect(earlyClose).toBe(false);
    ws.close();
  });
});
