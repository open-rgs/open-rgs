// H3 — responses are matched by a correlation id, not just frame type, so a
// late/duplicate response from a timed-out call can't resolve a newer
// request. Driven via a fake WebSocket so we can inject a stale frame.

import { describe, expect, test } from "bun:test";
import { encode, decode } from "@msgpack/msgpack";
import { RgsClient } from "../src/index.js";
import { FRAME } from "../src/codes.js";
import { WIRE_CORRELATION_KEY } from "@open-rgs/contract";

let created: FakeWS | undefined;

class FakeWS {
  binaryType = "arraybuffer";
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  sent: Uint8Array[] = [];
  constructor(public url: string) {
    created = this;
    queueMicrotask(() => this.onopen?.({}));
  }
  send(b: Uint8Array) { this.sent.push(b); }
  close() { this.onclose?.({}); }
  emit(frame: Uint8Array) {
    const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    this.onmessage?.({ data: ab });
  }
  lastSentCid(): string {
    const f = this.sent.at(-1)!;
    const payload = decode(f.subarray(1)) as Record<string, unknown>;
    return payload[WIRE_CORRELATION_KEY] as string;
  }
}

function frame(code: number, payload: object): Uint8Array {
  const body = encode(payload);
  const f = new Uint8Array(body.length + 1);
  f[0] = code;
  f.set(body, 1);
  return f;
}

describe("client correlation id (H3)", () => {
  test("requests carry a correlation id", async () => {
    const c = new RgsClient("ws://x", { webSocketImpl: FakeWS as unknown as typeof WebSocket });
    await c.connect();
    void c.spin({ betIndex: 1 });
    expect(created!.lastSentCid()).toBeTruthy();
  });

  test("a mismatched-cid response is dropped; the correct cid resolves", async () => {
    const c = new RgsClient("ws://x", { webSocketImpl: FakeWS as unknown as typeof WebSocket });
    await c.connect();

    const p = c.spin({ betIndex: 1 });
    const cid = created!.lastSentCid();

    // Stale response from some earlier/other call — wrong cid. Must be ignored.
    created!.emit(frame(FRAME.SPIN_RESPONSE, { roundId: "WRONG", win: 999, [WIRE_CORRELATION_KEY]: "stale-cid" }));
    // Correct response.
    created!.emit(frame(FRAME.SPIN_RESPONSE, { roundId: "RIGHT", win: 200, [WIRE_CORRELATION_KEY]: cid }));

    const r = await p;
    expect(r.roundId).toBe("RIGHT");
    expect(r.win).toBe(200);
    // The wire correlation key is stripped from the returned object.
    expect((r as unknown as Record<string, unknown>)[WIRE_CORRELATION_KEY]).toBeUndefined();
  });

  test("a mismatched-cid error frame does not fail the in-flight request", async () => {
    const c = new RgsClient("ws://x", { webSocketImpl: FakeWS as unknown as typeof WebSocket });
    await c.connect();

    const p = c.spin({ betIndex: 1 });
    const cid = created!.lastSentCid();

    // Stale error with the wrong cid — must NOT reject our request.
    created!.emit(frame(FRAME.ERROR, { code: "INTERNAL_ERROR", message: "stale", [WIRE_CORRELATION_KEY]: "stale-cid" }));
    // Correct response resolves it.
    created!.emit(frame(FRAME.SPIN_RESPONSE, { roundId: "OK", win: 0, [WIRE_CORRELATION_KEY]: cid }));

    const r = await p;
    expect(r.roundId).toBe("OK");
  });
});
