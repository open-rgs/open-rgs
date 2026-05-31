// Guarantee 6  - "At Most Once", at the socket. The opt-in replay guard makes a
// per-connection operation sequence authoritative: process last+1, REPLAY the
// cached response for a re-sent last (a dropped-response retry -> no re-run, no
// double settle), and REJECT a gap or a missing/garbage sequence. Off by
// default, so a client that doesn't stamp $seq is unaffected.

import { describe, expect, test, afterEach } from "bun:test";
import { encode, decode } from "@msgpack/msgpack";
import { binaryTransport, type BinaryClientTransport } from "../src/transport-binary.js";
import { WIRE_OPSEQ_KEY, WIRE_CORRELATION_KEY, type OrchestratorAPI } from "@open-rgs/contract";

const MSG_SPIN_REQUEST = 0x03;
const MSG_SPIN_RESPONSE = 0x04;

let nextPort = 18400;

// Counting orchestrator: each spin returns an incrementing roundId, so a
// REPLAYED response (same bytes) is distinguishable from a RE-RUN (new id), and
// we can assert how many times the orchestrator was actually reached.
function countingApi() {
  let spins = 0;
  const api = {
    init: async () => ({ sid: "s", balance: 1000, currency: "USD", currencyDecimals: 2, allowedBets: [10], defaultBetIndex: 0, modes: [] }),
    spin: async () => { spins++; return { roundId: `r-${spins}`, ops: [], balance: 1000 - spins, bet: 10, win: 0, multiplier: 0, type: "loss" }; },
    openRound: async () => { throw new Error("unreached"); },
    stepRound: async () => { throw new Error("unreached"); },
    closeRound: async () => { throw new Error("unreached"); },
    promoAccept: async () => { throw new Error("unreached"); },
    autocloseRound: async () => ({ closed: false }),
    onDisconnect: () => {},
  } as unknown as OrchestratorAPI;
  return { api, spins: () => spins };
}

function frame(type: number, payload: unknown): Uint8Array {
  const body = encode(payload);
  const f = new Uint8Array(1 + body.byteLength);
  f[0] = type;
  f.set(body, 1);
  return f;
}

async function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/wss`);
  ws.binaryType = "arraybuffer";
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res());
    ws.addEventListener("error", () => rej(new Error("ws error")));
  });
  return ws;
}

/** Send a frame, resolve with the next decoded response payload. */
function roundtrip(ws: WebSocket, f: Uint8Array): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      ws.removeEventListener("message", onMsg);
      const bytes = new Uint8Array(e.data as ArrayBuffer);
      resolve({ type: bytes[0], payload: decode(bytes.subarray(1)) });
    };
    ws.addEventListener("message", onMsg);
    setTimeout(() => { ws.removeEventListener("message", onMsg); reject(new Error("no response in 2s")); }, 2000);
    ws.send(f);
  });
}

describe("transport replay guard (Guarantee 6)", () => {
  let transport: BinaryClientTransport | undefined;
  afterEach(async () => { await transport?.stop({ drainMs: 10 }); transport = undefined; });

  test("a duplicate op-seq REPLAYS the cached response and does NOT re-run the round", async () => {
    const { api, spins } = countingApi();
    const port = nextPort++;
    transport = binaryTransport({ port, replayGuard: true });
    await transport.start(api);
    const ws = await openWs(port);

    // seq 1  - processed, roundId r-1.
    const r1 = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0, [WIRE_OPSEQ_KEY]: 1, [WIRE_CORRELATION_KEY]: "a" }));
    expect(r1.type).toBe(MSG_SPIN_RESPONSE);
    expect(r1.payload.roundId).toBe("r-1");

    // seq 1 again  - duplicate. Must replay r-1 verbatim, NOT run a new spin.
    const dup = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0, [WIRE_OPSEQ_KEY]: 1, [WIRE_CORRELATION_KEY]: "a" }));
    expect(dup.payload.roundId).toBe("r-1");
    expect(spins()).toBe(1); // orchestrator reached exactly once

    // seq 2  - advances, new round.
    const r2 = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0, [WIRE_OPSEQ_KEY]: 2, [WIRE_CORRELATION_KEY]: "b" }));
    expect(r2.payload.roundId).toBe("r-2");
    expect(spins()).toBe(2);
    ws.close();
  });

  test("a gap in the sequence is rejected", async () => {
    const { api, spins } = countingApi();
    const port = nextPort++;
    transport = binaryTransport({ port, replayGuard: true });
    await transport.start(api);
    const ws = await openWs(port);

    await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0, [WIRE_OPSEQ_KEY]: 1 }));
    // Jump to seq 3 (skipping 2)  - must error, must not run.
    const gap = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0, [WIRE_OPSEQ_KEY]: 3 }));
    expect(gap.type).toBe(0xff); // MSG_ERROR
    expect(gap.payload.code).toBe("INVALID_FORMAT");
    expect(spins()).toBe(1);
    ws.close();
  });

  test("a missing sequence is rejected when the guard is on", async () => {
    const { api } = countingApi();
    const port = nextPort++;
    transport = binaryTransport({ port, replayGuard: true });
    await transport.start(api);
    const ws = await openWs(port);
    const r = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0 })); // no $seq
    expect(r.type).toBe(0xff);
    expect(r.payload.code).toBe("INVALID_FORMAT");
    ws.close();
  });

  test("with the guard OFF (default), a frame without $seq is processed normally", async () => {
    const { api, spins } = countingApi();
    const port = nextPort++;
    transport = binaryTransport({ port }); // guard off
    await transport.start(api);
    const ws = await openWs(port);
    const r = await roundtrip(ws, frame(MSG_SPIN_REQUEST, { betIndex: 0 }));
    expect(r.type).toBe(MSG_SPIN_RESPONSE);
    expect(spins()).toBe(1);
    ws.close();
  });
});
