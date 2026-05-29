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
import {
  WIRE_CORRELATION_KEY,
  type ClientRequestInit, type ClientResponseInit,
  type ClientRequestSpin, type ClientResponseSpin,
  type ClientRequestOpenRound, type ClientResponseOpenRound,
  type ClientRequestStepRound, type ClientResponseStepRound,
  type ClientRequestCloseRound, type ClientResponseCloseRound,
  type ClientRequestPromoAccept, type ClientResponsePromoAccept,
  type ClientResponseError, type RGSErrorCode,
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
  /** Correlation id stamped on this request; the response must echo it. */
  cid: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

let cidSeq = 0;
function nextCid(): string {
  // Unique per process+call; enough to disambiguate a late response from a
  // timed-out request against a newer one on the same connection.
  cidSeq += 1;
  return `c${cidSeq}-${Math.trunc(performance.now())}`;
}

/** Drop the wire correlation key so callers get a clean response object. */
function stripCid(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { [WIRE_CORRELATION_KEY]: _omit, ...rest } = payload as Record<string, unknown>;
  return rest;
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
    const cid = nextCid();
    const body = encode({ ...(payload as Record<string, unknown>), [WIRE_CORRELATION_KEY]: cid });
    const frame = new Uint8Array(body.length + 1);
    frame[0] = typeOut;
    frame.set(body, 1);

    const timeoutMs = this.opts.rpcTimeoutMs ?? 8_000;

    return new Promise<Resp>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending?.cid === cid) this.pending = undefined;
        reject(new Error(`RgsClient: request 0x${typeOut.toString(16)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { expect: expectIn, cid, resolve: resolve as (v: unknown) => void, reject, timeout };
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

    const cid = (payload && typeof payload === "object")
      ? (payload as Record<string, unknown>)[WIRE_CORRELATION_KEY]
      : undefined;

    // A frame carrying a correlation id must match the in-flight request's id.
    // A mismatch is a stale/duplicate response from a timed-out call — drop it
    // so it can't resolve a newer request. (Pre-dispatch errors and legacy
    // servers may omit the id; those fall through to the type match.)
    if (cid !== undefined && this.pending && cid !== this.pending.cid) return;

    // Server-side error frame — fails the matching in-flight request.
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
      this.pending.resolve(stripCid(payload));
      this.pending = undefined;
    }
    // Else drop — could be a stale response after timeout, or out-of-band push.
  }
}
