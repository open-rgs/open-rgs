// ConcurrencyPolicy enforcement (Spec 02): when a second connection INITs a
// session that is already attached to another LIVE connection, the
// orchestrator arbitrates - kick-old (default), reject-new, or allow. A
// dropped connection detaches first, so a plain reconnect is never policed.
//
// Unit tests drive the orchestrator with a fake kick capability; the
// integration test runs the real binaryTransport and asserts the kicked
// socket receives a SESSION_IN_USE error frame followed by a close.

import { describe, expect, test, afterEach } from "bun:test";
import { encode, decode } from "@msgpack/msgpack";
import { createOrchestrator } from "../src/index.js";
import { binaryTransport, MSG_INIT_REQUEST, MSG_INIT_RESPONSE, MSG_ERROR, type BinaryClientTransport } from "../src/transport-binary.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath,
  type ConnectionMeta, type PlatformEvent, type ConcurrencyPolicy,
} from "@open-rgs/contract";

class Wallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.balance += -req.bet + req.win;
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r${++this.seq}`, balance: this.balance }; }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const half: SimpleMath = {
  kind: "simple", name: "half", version: "1", rtp: 0.5,
  play: () => ({ multiplier: 0.5, ops: [], type: "win" }),
};

function setup(policy?: ConcurrencyPolicy) {
  const kicked: string[] = [];
  const manifest = defineGame({
    id: "g", declaredRtp: 0.5, defaultMode: "base", maxWinMultiplier: 1000,
    modes: { base: { math: half, stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({
    manifest, platform: new Wallet(),
    ...(policy ? { concurrencyPolicy: policy } : {}),
    kickConnection: (id) => kicked.push(id),
  });
  const conn = (id: string): ConnectionMeta => ({ connectionId: id, sessionId: null, demo: false });
  return { orch, kicked, conn };
}

describe("ConcurrencyPolicy - orchestrator", () => {
  test("kick-old (default): second window supersedes, first is kicked", async () => {
    const { orch, kicked, conn } = setup();
    const a = conn("conn-a"), b = conn("conn-b");
    await orch.init({ sid: "p1" }, a);
    await orch.init({ sid: "p1" }, b);
    expect(kicked).toEqual(["conn-a"]);
    // The new owner can play.
    const r = await orch.spin({ betIndex: 0 }, b);
    expect(r.bet).toBe(100);
  });

  test("kicked connection's late disconnect does not evict the new owner", async () => {
    const { orch, conn } = setup();
    const a = conn("conn-a"), b = conn("conn-b");
    await orch.init({ sid: "p2" }, a);
    await orch.init({ sid: "p2" }, b);
    // Old socket's close event arrives after the takeover.
    orch.onDisconnect(a);
    const r = await orch.spin({ betIndex: 0 }, b);   // session must still exist
    expect(r.balance).toBeGreaterThan(0);
  });

  test("reject-new: second INIT fails with SESSION_IN_USE, first keeps playing", async () => {
    const { orch, kicked, conn } = setup("reject-new");
    const a = conn("conn-a"), b = conn("conn-b");
    await orch.init({ sid: "p3" }, a);
    let err: unknown;
    try { await orch.init({ sid: "p3" }, b); } catch (e) { err = e; }
    expect((err as RGSError).code).toBe("SESSION_IN_USE");
    expect(kicked).toEqual([]);
    const r = await orch.spin({ betIndex: 0 }, a);
    expect(r.bet).toBe(100);
  });

  test("reject-new: after the first connection drops, a new one attaches freely", async () => {
    const { orch, conn } = setup("reject-new");
    const a = conn("conn-a"), b = conn("conn-b");
    await orch.init({ sid: "p4" }, a);
    orch.onDisconnect(a);                             // detach
    const resp = await orch.init({ sid: "p4" }, b);   // no SESSION_IN_USE
    expect(resp.sid).toBe("p4");
  });

  test("allow: both connections coexist, nobody kicked", async () => {
    const { orch, kicked, conn } = setup("allow");
    const a = conn("conn-a"), b = conn("conn-b");
    await orch.init({ sid: "p5" }, a);
    await orch.init({ sid: "p5" }, b);
    expect(kicked).toEqual([]);
    const ra = await orch.spin({ betIndex: 0 }, a);
    const rb = await orch.spin({ betIndex: 0 }, b);
    expect(ra.roundId).not.toBe(rb.roundId);
  });

  test("same connection re-INIT is not policed", async () => {
    const { orch, kicked, conn } = setup();
    const a = conn("conn-a");
    await orch.init({ sid: "p6" }, a);
    await orch.init({ sid: "p6" }, a);
    expect(kicked).toEqual([]);
  });
});

// --- integration: real transport, real sockets -------------------------------

function frame(type: number, payload: unknown): Uint8Array {
  const body = encode(payload);
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

interface Caught { type: number; payload: Record<string, unknown> }

function tapWs(port: number): Promise<{ ws: WebSocket; frames: Caught[]; closed: Promise<{ code: number }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/wss`);
    ws.binaryType = "arraybuffer";
    const frames: Caught[] = [];
    let closeResolve: (v: { code: number }) => void;
    const closed = new Promise<{ code: number }>((r) => { closeResolve = r; });
    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      frames.push({ type: bytes[0]!, payload: (bytes.length > 1 ? decode(bytes.subarray(1)) : {}) as Record<string, unknown> });
    };
    ws.onclose = (ev) => closeResolve({ code: ev.code });
    ws.onopen = () => resolve({ ws, frames, closed });
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
}

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await Bun.sleep(10);
  if (!cond()) throw new Error("condition not reached");
}

let transport: BinaryClientTransport | undefined;
afterEach(() => { transport?.stop(); transport = undefined; });

describe("ConcurrencyPolicy - transport integration (kick-old)", () => {
  test("old socket gets SESSION_IN_USE error frame, then close 4000; new socket wins", async () => {
    const manifest = defineGame({
      id: "g", declaredRtp: 0.5, defaultMode: "base", maxWinMultiplier: 1000,
      modes: { base: { math: half, stakeMultiplier: 1 } },
    });
    const port = 19_431;
    transport = binaryTransport({ port });
    const t = transport;
    const orch = createOrchestrator({
      manifest, platform: new Wallet(),
      // Same wiring createServer does: orchestrator kick -> transport close.
      kickConnection: (id, reason) => t.closeConnection(id, "SESSION_IN_USE", reason),
    });
    await transport.start(orch);

    const w1 = await tapWs(port);
    w1.ws.send(frame(MSG_INIT_REQUEST, { sid: "dup" }));
    await until(() => w1.frames.some((f) => f.type === MSG_INIT_RESPONSE));

    const w2 = await tapWs(port);
    w2.ws.send(frame(MSG_INIT_REQUEST, { sid: "dup" }));
    await until(() => w2.frames.some((f) => f.type === MSG_INIT_RESPONSE));

    // The first socket was kicked: a structured error frame, then the close.
    await until(() => w1.frames.some((f) => f.type === MSG_ERROR));
    const err = w1.frames.find((f) => f.type === MSG_ERROR)!;
    expect(err.payload["code"]).toBe("SESSION_IN_USE");
    const closed = await w1.closed;
    expect(closed.code).toBe(4000);

    w2.ws.close();
  });
});
