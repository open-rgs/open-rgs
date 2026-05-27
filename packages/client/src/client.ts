// Open-RGS WebSocket client. Promise-based, msgpack-encoded.
//
// Usage:
//   const c = new RgsClient("ws://localhost:8080/wss");
//   await c.connect();
//   const init = await c.init("session-1");
//   const spin = await c.spin({ betIndex: 2 });
//   c.disconnect();
//
// One request in flight at a time per connection — same constraint
// the orchestrator's wire spec assumes. Concurrent calls reject.

import { encode, decode } from "@msgpack/msgpack";
import type {
  ClientRequestInit, ClientResponseInit,
  ClientRequestSpin, ClientResponseSpin,
  ClientRequestOpenRound, ClientResponseOpenRound,
  ClientRequestStepRound, ClientResponseStepRound,
  ClientRequestCloseRound, ClientResponseCloseRound,
  ClientRequestPromoAccept, ClientResponsePromoAccept,
  ClientResponseError, RGSErrorCode,
} from "@open-rgs/contract";
import { FRAME, type FrameCode } from "./codes.js";

export class RgsServerError extends Error {
  constructor(public readonly code: RGSErrorCode, message: string) {
    super(message);
    this.name = "RgsServerError";
  }
}

export interface RgsClientOptions {
  /** Per-call deadline. Default 8s. */
  rpcTimeoutMs?: number;
  /** Override the WebSocket constructor (test injection or non-DOM environments). */
  webSocketImpl?: typeof WebSocket;
}

interface Pending {
  expect: FrameCode;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class RgsClient {
  private ws: WebSocket | undefined;
  private pending: Pending | undefined;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly opts: RgsClientOptions = {},
  ) {}

  async connect(): Promise<void> {
    const WS = this.opts.webSocketImpl ?? WebSocket;
    return new Promise((resolve, reject) => {
      const ws = new WS(this.url);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onmessage = (ev) => this.handleFrame(ev.data);
      ws.onclose = () => {
        this.ws = undefined;
        this.closed = true;
        if (this.pending) {
          clearTimeout(this.pending.timeout);
          this.pending.reject(new Error("RgsClient: connection closed"));
          this.pending = undefined;
        }
      };
      ws.onerror = () => {
        if (!this.ws) reject(new Error("RgsClient: failed to connect"));
      };
    });
  }

  disconnect(): void {
    this.closed = true;
    try { this.ws?.close(1000, "bye"); } catch { /* swallow */ }
  }

  get isConnected(): boolean { return this.ws != null && !this.closed; }

  // ─── public RPC surface ─────────────────────────────────────────────

  init(sid: string): Promise<ClientResponseInit> {
    return this.send<ClientRequestInit, ClientResponseInit>(
      FRAME.INIT_REQUEST, { sid }, FRAME.INIT_RESPONSE);
  }
  spin(req: ClientRequestSpin): Promise<ClientResponseSpin> {
    return this.send(FRAME.SPIN_REQUEST, req, FRAME.SPIN_RESPONSE);
  }
  openRound(req: ClientRequestOpenRound): Promise<ClientResponseOpenRound> {
    return this.send(FRAME.OPEN_REQUEST, req, FRAME.OPEN_RESPONSE);
  }
  stepRound(req: ClientRequestStepRound): Promise<ClientResponseStepRound> {
    return this.send(FRAME.STEP_REQUEST, req, FRAME.STEP_RESPONSE);
  }
  closeRound(req: ClientRequestCloseRound): Promise<ClientResponseCloseRound> {
    return this.send(FRAME.CLOSE_REQUEST, req, FRAME.CLOSE_RESPONSE);
  }
  promoAccept(req: ClientRequestPromoAccept): Promise<ClientResponsePromoAccept> {
    return this.send(FRAME.PROMO_ACCEPT, req, FRAME.PROMO_ACCEPT_RESP);
  }

  // ─── private ────────────────────────────────────────────────────────

  private send<Req, Resp>(typeOut: FrameCode, payload: Req, expectIn: FrameCode): Promise<Resp> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error("RgsClient: not connected"));
    }
    if (this.pending) {
      return Promise.reject(new Error("RgsClient: another request is in flight"));
    }
    const body = encode(payload as unknown as Record<string, unknown>);
    const frame = new Uint8Array(body.length + 1);
    frame[0] = typeOut;
    frame.set(body, 1);

    const timeoutMs = this.opts.rpcTimeoutMs ?? 8_000;

    return new Promise<Resp>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.expect === expectIn) this.pending = undefined;
        reject(new Error(`RgsClient: request 0x${typeOut.toString(16)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { expect: expectIn, resolve: resolve as (v: unknown) => void, reject, timeout };
      try { this.ws!.send(frame); }
      catch (e) {
        clearTimeout(timeout);
        this.pending = undefined;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private handleFrame(raw: unknown): void {
    if (!(raw instanceof ArrayBuffer) && !ArrayBuffer.isView(raw)) return;
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.length === 0) return;
    const code = bytes[0]! as FrameCode;
    let payload: unknown = {};
    if (bytes.length > 1) {
      try { payload = decode(bytes.subarray(1)); }
      catch { /* malformed; drop */ return; }
    }

    // Server-side error frame — fails any in-flight request.
    if (code === FRAME.ERROR) {
      const err = payload as ClientResponseError;
      if (this.pending) {
        clearTimeout(this.pending.timeout);
        this.pending.reject(new RgsServerError(err.code, err.message));
        this.pending = undefined;
      }
      return;
    }

    // PONGs are unsolicited — just acknowledge silently.
    if (code === FRAME.PONG) return;

    if (this.pending?.expect === code) {
      clearTimeout(this.pending.timeout);
      this.pending.resolve(payload);
      this.pending = undefined;
    }
    // Else drop — could be a stale response after timeout, or out-of-band push.
  }
}
