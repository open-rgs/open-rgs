// Binary MessagePack client transport. Wire frames are
// [type_byte][msgpack_payload]. Reference impl; alternative transports
// (json-ws, rest, gRPC) plug into the same OrchestratorAPI.

import { encode, decode } from "@msgpack/msgpack";
import {
  RGSError,
  WIRE_CORRELATION_KEY,
  type ClientTransport,
  type OrchestratorAPI,
  type ConnectionMeta,
  type RGSErrorCode,
} from "@open-rgs/contract";
import { log } from "./log.js";

/** Max wire frame size, both directions (Spec 04: a frame >1 MiB SHOULD
 *  disconnect). Inbound: enforced by Bun via `maxPayloadLength` (oversized
 *  frames close the connection, never reaching the handler). Outbound:
 *  `sendFrame` refuses to emit a larger frame (a runaway math `ops` array
 *  could otherwise produce an unbounded response). */
export const MAX_FRAME_BYTES = 1024 * 1024;

// Frame type codes
export const MSG_INIT_REQUEST       = 0x01;
export const MSG_INIT_RESPONSE      = 0x02;
export const MSG_SPIN_REQUEST       = 0x03;
export const MSG_SPIN_RESPONSE      = 0x04;
export const MSG_OPEN_REQUEST       = 0x05;
export const MSG_OPEN_RESPONSE      = 0x06;
export const MSG_STEP_REQUEST       = 0x07;
export const MSG_STEP_RESPONSE      = 0x08;
export const MSG_CLOSE_REQUEST      = 0x09;
export const MSG_CLOSE_RESPONSE     = 0x0a;
export const MSG_PROMO_ACCEPT       = 0x0b;
export const MSG_PROMO_ACCEPT_RESP  = 0x0c;
export const MSG_PING               = 0xfe;
export const MSG_PONG               = 0xfd;
export const MSG_ERROR              = 0xff;

interface WsData extends ConnectionMeta {
  connectedAt: number;
}

export interface BinaryTransportConfig {
  port: number;
  /** WS path patterns. Default: /wss, /api/wss. */
  paths?: string[];
  /** Optional connect/disconnect hooks. Used by createServer to wire
   *  the ws-connections gauge into the metrics registry. */
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** Optional HTTP fetch handler invoked for any request that doesn't
   *  match the WS upgrade paths. Used by createServer to mount the
   *  admin / probe routes on the same port. Returning undefined falls
   *  through to the built-in 404 (after the /livez fallback). */
  extraFetch?: (req: Request) => Promise<Response | undefined> | Response | undefined;
}

/** ClientTransport extended with a setter for the optional admin
 *  fetch handler. createServer narrows to this to wire single-port
 *  mode without modifying the public ClientTransport contract. */
export interface BinaryClientTransport extends ClientTransport {
  /** Install a fetch handler invoked for any non-WS request on the
   *  transport's port. Idempotent; last write wins. Must be called
   *  BEFORE start(). */
  setExtraFetch(fn: (req: Request) => Promise<Response | undefined> | Response | undefined): void;
}

export function binaryTransport(cfg: BinaryTransportConfig): BinaryClientTransport {
  let server: ReturnType<typeof Bun.serve<WsData>> | undefined;
  const wsPaths = new Set(cfg.paths ?? ["/wss", "/api/wss"]);
  let accepting = true;
  let inflight = 0;
  let extraFetch = cfg.extraFetch;

  return {
    setExtraFetch(fn) { extraFetch = fn; },

    async start(api: OrchestratorAPI): Promise<{ port: number }> {
      server = Bun.serve<WsData>({
        port: cfg.port,
        fetch: async (req, srv) => {
          const url = new URL(req.url);
          if (wsPaths.has(url.pathname)) {
            if (!accepting) {
              return new Response("Server draining", { status: 503 });
            }
            const data: WsData = {
              connectionId: crypto.randomUUID(),
              sessionId: null,
              demo: false,
              connectedAt: 0,
            };
            const upgraded = srv.upgrade(req, { data });
            if (upgraded) return undefined;
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          if (extraFetch) {
            const res = await extraFetch(req);
            if (res) return res;
          }
          // Minimal fallback when no extraFetch handler claims the
          // request  - keeps a bare transport usable in tests.
          if (url.pathname === "/livez") return new Response("OK");
          return new Response("Not found", { status: 404 });
        },
        websocket: {
          // Reject oversized inbound frames at the WS layer  - Bun closes the
          // connection (1009) before the handler runs (Spec 04, H2).
          maxPayloadLength: MAX_FRAME_BYTES,
          open(ws) {
            ws.data.connectedAt = Date.now();
            cfg.onConnect?.();
            log.info("Client connected", {
              "event.category": "transport",
              "event.action": "ws_open",
              "connection.id": ws.data.connectionId,
            });
          },
          async message(ws, raw) {
            if (typeof raw === "string") {
              return sendError(ws, "INVALID_FORMAT", "Expected binary frame");
            }
            const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            if (bytes.byteLength === 0) {
              return sendError(ws, "INVALID_FORMAT", "Empty frame");
            }
            const type = bytes[0]!;
            let payload: unknown;
            try {
              payload = bytes.byteLength > 1 ? decode(bytes.subarray(1)) : {};
            } catch (e) {
              return sendError(ws, "DECODE_ERROR", `Frame decode failed: ${e}`);
            }
            inflight++;
            try {
              await dispatch(ws, type, payload, api);
            } finally {
              inflight--;
            }
          },
          close(ws) {
            api.onDisconnect(ws.data);
            cfg.onDisconnect?.();
            log.info("Client disconnected", {
              "event.category": "transport",
              "event.action": "ws_close",
              "connection.id": ws.data.connectionId,
              "session.id": ws.data.sessionId,
              "lifetime.ms": ws.data.connectedAt ? Date.now() - ws.data.connectedAt : -1,
            });
          },
        },
      });

      log.info("Binary transport listening", {
        "event.category": "transport",
        "event.action": "listen",
        "server.port": cfg.port,
      });
      return { port: cfg.port };
    },

    async stop(opts: { drainMs?: number } = {}): Promise<void> {
      accepting = false;
      const drainMs = opts.drainMs ?? 30_000;
      const deadline = Date.now() + drainMs;

      log.info("Transport draining", {
        "event.category": "transport",
        "event.action": "drain_start",
        "drain.ms": drainMs,
        "inflight": inflight,
      });

      // Poll until in-flight requests complete OR deadline expires.
      while (inflight > 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50));
      }

      if (inflight > 0) {
        log.warn("Transport drain deadline exceeded  - forcing close", {
          "event.category": "transport",
          "event.action": "drain_timeout",
          "inflight": inflight,
        });
      } else {
        log.info("Transport drained cleanly", {
          "event.category": "transport",
          "event.action": "drain_complete",
        });
      }

      server?.stop();
    },
  };
}

async function dispatch(
  ws: { send: (b: Uint8Array) => void; data: WsData },
  type: number,
  payload: unknown,
  api: OrchestratorAPI,
): Promise<void> {
  const conn = ws.data;
  // Echo the request's correlation id on the response/error so the client
  // matches by id (not just frame type) and a late response can't resolve a
  // newer call.
  const cid = correlationId(payload);
  const reply = (t: number, resp: unknown): void => sendFrame(ws, t, withCid(resp, cid));
  try {
    switch (type) {
      case MSG_INIT_REQUEST:
        return reply(MSG_INIT_RESPONSE, await api.init(payload as Parameters<OrchestratorAPI["init"]>[0], conn));
      case MSG_SPIN_REQUEST:
        return reply(MSG_SPIN_RESPONSE, await api.spin(payload as Parameters<OrchestratorAPI["spin"]>[0], conn));
      case MSG_OPEN_REQUEST:
        return reply(MSG_OPEN_RESPONSE, await api.openRound(payload as Parameters<OrchestratorAPI["openRound"]>[0], conn));
      case MSG_STEP_REQUEST:
        return reply(MSG_STEP_RESPONSE, await api.stepRound(payload as Parameters<OrchestratorAPI["stepRound"]>[0], conn));
      case MSG_CLOSE_REQUEST:
        return reply(MSG_CLOSE_RESPONSE, await api.closeRound(payload as Parameters<OrchestratorAPI["closeRound"]>[0], conn));
      case MSG_PROMO_ACCEPT:
        return reply(MSG_PROMO_ACCEPT_RESP, await api.promoAccept(payload as Parameters<OrchestratorAPI["promoAccept"]>[0], conn));
      case MSG_PING:
        return sendFrame(ws, MSG_PONG, {}); // unsolicited  - no correlation id
      default:
        return sendError(ws, "DECODE_ERROR", `Unknown msg type 0x${type.toString(16)}`, cid);
    }
  } catch (e) {
    const err = e instanceof RGSError
      ? e
      : new RGSError("INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
    // Codes whose message wraps arbitrary internal detail (a Lua runtime
    // error with a file path, an upstream wallet body, a stack). Never send
    // that to the client  - log it server-side and return a generic message
    // plus the correlation id so an operator can find the log line. (M11)
    if (OPAQUE_ERROR_CODES.has(err.code)) {
      log.exception("transport dispatch error", e, {
        "event.category": "transport",
        "error.code": err.code,
        "correlation.id": cid === undefined ? "" : String(cid),
      });
      sendError(ws, err.code, `internal error (ref: ${cid === undefined ? "n/a" : String(cid)})`, cid);
    } else {
      // Controlled-vocabulary errors (INVALID_BET, INSUFFICIENT_BALANCE, ...)
      // carry author-written, non-sensitive messages  - safe to surface.
      sendError(ws, err.code, err.message, cid);
    }
  }
}

/** Error codes whose `message` may contain internal detail (wrapped Lua /
 *  upstream errors). Their client-facing message is genericized. */
const OPAQUE_ERROR_CODES: ReadonlySet<RGSErrorCode> = new Set<RGSErrorCode>([
  "INTERNAL_ERROR", "INIT_FAILED", "SPIN_FAILED", "OPEN_FAILED", "STEP_FAILED", "CLOSE_FAILED",
]);

/** Read the correlation id a client stamped on a request payload. */
function correlationId(payload: unknown): unknown {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[WIRE_CORRELATION_KEY]
    : undefined;
}

/** Stamp a correlation id onto a response payload (no-op if absent). */
function withCid(resp: unknown, cid: unknown): unknown {
  if (cid === undefined || resp === null || typeof resp !== "object") return resp;
  return { ...(resp as Record<string, unknown>), [WIRE_CORRELATION_KEY]: cid };
}

function sendFrame(ws: { send: (b: Uint8Array) => void }, type: number, payload: unknown): void {
  const body = encode(payload);
  if (1 + body.byteLength > MAX_FRAME_BYTES) {
    // A runaway ops array (Op is forwarded untouched) must not produce an
    // unbounded outbound frame. Drop it and send a bounded error instead.
    log.error("Outbound frame exceeds max size  - dropping", {
      "event.category": "transport",
      "event.action": "frame_too_large",
      "frame.type": type,
      "frame.bytes": body.byteLength,
      "frame.max_bytes": MAX_FRAME_BYTES,
    });
    const errBody = encode({ code: "INTERNAL_ERROR" as RGSErrorCode, message: "response too large" });
    const errFrame = new Uint8Array(1 + errBody.byteLength);
    errFrame[0] = MSG_ERROR;
    errFrame.set(errBody, 1);
    ws.send(errFrame);
    return;
  }
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = type;
  frame.set(body, 1);
  ws.send(frame);
}

function sendError(ws: { send: (b: Uint8Array) => void }, code: RGSErrorCode, message: string, cid?: unknown): void {
  sendFrame(ws, MSG_ERROR, withCid({ code, message }, cid));
}
