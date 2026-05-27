// Binary MessagePack client transport. Wire frames are
// [type_byte][msgpack_payload]. Reference impl; alternative transports
// (json-ws, rest, gRPC) plug into the same OrchestratorAPI.

import { encode, decode } from "@msgpack/msgpack";
import {
  RGSError,
  type ClientTransport,
  type OrchestratorAPI,
  type ConnectionMeta,
  type RGSErrorCode,
} from "@open-rgs/contract";
import { log } from "./log.js";

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
  try {
    switch (type) {
      case MSG_INIT_REQUEST: {
        const resp = await api.init(payload as Parameters<OrchestratorAPI["init"]>[0], conn);
        return sendFrame(ws, MSG_INIT_RESPONSE, resp);
      }
      case MSG_SPIN_REQUEST: {
        const resp = await api.spin(payload as Parameters<OrchestratorAPI["spin"]>[0], conn);
        return sendFrame(ws, MSG_SPIN_RESPONSE, resp);
      }
      case MSG_OPEN_REQUEST: {
        const resp = await api.openRound(payload as Parameters<OrchestratorAPI["openRound"]>[0], conn);
        return sendFrame(ws, MSG_OPEN_RESPONSE, resp);
      }
      case MSG_STEP_REQUEST: {
        const resp = await api.stepRound(payload as Parameters<OrchestratorAPI["stepRound"]>[0], conn);
        return sendFrame(ws, MSG_STEP_RESPONSE, resp);
      }
      case MSG_CLOSE_REQUEST: {
        const resp = await api.closeRound(payload as Parameters<OrchestratorAPI["closeRound"]>[0], conn);
        return sendFrame(ws, MSG_CLOSE_RESPONSE, resp);
      }
      case MSG_PROMO_ACCEPT: {
        const resp = await api.promoAccept(payload as Parameters<OrchestratorAPI["promoAccept"]>[0], conn);
        return sendFrame(ws, MSG_PROMO_ACCEPT_RESP, resp);
      }
      case MSG_PING:
        return sendFrame(ws, MSG_PONG, {});
      default:
        return sendError(ws, "DECODE_ERROR", `Unknown msg type 0x${type.toString(16)}`);
    }
  } catch (e) {
    if (e instanceof RGSError) {
      sendError(ws, e.code, e.message);
    } else {
      log.exception("Unhandled error in transport dispatch", e);
      sendError(ws, "INTERNAL_ERROR", e instanceof Error ? e.message : String(e));
    }
  }
}

function sendFrame(ws: { send: (b: Uint8Array) => void }, type: number, payload: unknown): void {
  const body = encode(payload);
  const frame = new Uint8Array(1 + body.byteLength);
  frame[0] = type;
  frame.set(body, 1);
  ws.send(frame);
}

function sendError(ws: { send: (b: Uint8Array) => void }, code: RGSErrorCode, message: string): void {
  sendFrame(ws, MSG_ERROR, { code, message });
}
