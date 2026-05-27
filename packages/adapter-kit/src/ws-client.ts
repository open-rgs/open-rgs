// Reconnecting WebSocket client with correlation-id RPC. The most
// common upstream shape for slot platforms — extracted so adapters
// don't each reinvent it.
//
// What you get:
//   • Persistent WS with exponential backoff (capped)
//   • Custom HTTP headers on the upgrade (auth)
//   • request(method, params) → Promise<result> with per-call timeout
//   • Inbound event fanout
//   • Diagnostics counters that drop straight into your /healthz
//   • Verbose error logging — extracts message/code/url from any
//     failure mode (DNS, TLS, 401, ECONNREFUSED, etc) instead of the
//     opaque "[object ErrorEvent]" the browser-style WebSocket produces
//
// What you bring:
//   • encodeRequest(corrId, method, params) → frame
//   • decodeFrame(raw) → { kind: "resp"|"event"|"pong"|"ignore", … }
//
// Encoding is yours because every platform is bespoke. The transport
// loop is ours because every adapter does it the same way.

import WebSocket from "ws";
import type { DiagnosticsHandle } from "./diagnostics.js";

export type WsFrame = string | ArrayBufferLike | ArrayBufferView;

export interface DecodedResponse {
  kind: "resp";
  corrId: number;
  result?: unknown;
  error?: { code?: string; message: string };
}
export interface DecodedEvent { kind: "event"; event: unknown }
export interface DecodedPong  { kind: "pong" }
export interface DecodedIgnore { kind: "ignore" }
export type Decoded = DecodedResponse | DecodedEvent | DecodedPong | DecodedIgnore;

export interface WsClientOptions {
  /** ws:// or wss:// endpoint. */
  url: string;
  /** Optional HTTP headers sent during the upgrade. Most slot platforms
   *  auth via X-Game-ID / X-Api-Key / Authorization. The browser
   *  WebSocket API can't set these — this kit uses the `ws` npm
   *  package which can. */
  headers?: Record<string, string>;
  /** Optional WS subprotocols. e.g. ["json"] for your platform. */
  protocols?: string | string[];
  /** Encode an RPC request frame. */
  encodeRequest: (corrId: number, method: string, params: unknown) => WsFrame;
  /** Decode an inbound frame into one of the discriminated kinds. */
  decodeFrame: (raw: string | ArrayBuffer) => Decoded;
  /** Per-call RPC deadline. Default 8s. */
  rpcTimeoutMs?: number;
  /** Base reconnect delay; doubled each attempt, capped at 30s. Default 500ms. */
  reconnectBaseMs?: number;
  /** Called whenever an event-kind frame arrives. */
  onEvent: (event: unknown) => void;
  /** Diagnostics handle. Counters updated automatically. */
  diagnostics?: DiagnosticsHandle;
  /** Per-message logger; receives wire-level events. */
  log?: {
    debug?: (msg: string, fields?: Record<string, unknown>) => void;
    info?:  (msg: string, fields?: Record<string, unknown>) => void;
    warn?:  (msg: string, fields?: Record<string, unknown>) => void;
    error?: (msg: string, fields?: Record<string, unknown>) => void;
  };
  /** Lifecycle hooks for adapter-side handshakes (auth/subscribe). */
  onOpen?: () => void | Promise<void>;
  onClose?: (ev: { code: number; reason: string }) => void;
}

interface PendingRpc {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  method: string;
}

export class WsClient {
  private ws: WebSocket | undefined;
  private connected = false;
  private nextCorrId = 1;
  private pending = new Map<number, PendingRpc>();
  private reconnectAttempt = 0;
  private rpcDeadlineMs: number;
  private stopped = false;

  constructor(private readonly opts: WsClientOptions) {
    this.rpcDeadlineMs = opts.rpcTimeoutMs ?? 8_000;
  }

  /** Open the WebSocket; resolves when the initial onopen fires (and
   *  onOpen handshake, if any, completes). */
  connect(): Promise<void> {
    return this.openOnce();
  }

  /** Close gracefully; cancels all pending RPCs and prevents auto-reconnect. */
  close(reason = "shutdown"): void {
    this.stopped = true;
    try {
      this.ws?.close(1000, reason);
    } catch (e) {
      this.opts.log?.warn?.("WsClient.close() threw", {
        "event.category": "adapter",
        "event.action":   "ws_close_threw",
        "error.message":  e instanceof Error ? e.message : String(e),
      });
    }
    this.failAllPending(new Error(`WsClient closed: ${reason}`));
  }

  get isConnected(): boolean { return this.connected; }

  /** Issue an RPC. Returns the decoded `result` field of the matching response. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new Error(`WsClient not connected (method=${method})`));
    }
    const corrId = this.nextCorrId++;
    let frame: WsFrame;
    try {
      frame = this.opts.encodeRequest(corrId, method, params);
    } catch (e) {
      return Promise.reject(new Error(`encodeRequest failed for ${method}: ${e instanceof Error ? e.message : String(e)}`));
    }
    this.opts.diagnostics?.noteRpcStart();
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(corrId);
        this.opts.diagnostics?.noteRpcDone(false);
        reject(new Error(`RPC ${method} timed out after ${this.rpcDeadlineMs}ms`));
      }, this.rpcDeadlineMs);
      this.pending.set(corrId, { resolve, reject, timeout, method });
      try {
        // `ws` package accepts string | Buffer | ArrayBuffer | TypedArray
        this.ws!.send(frame as Parameters<WebSocket["send"]>[0]);
      } catch (e) {
        clearTimeout(timeout);
        this.pending.delete(corrId);
        this.opts.diagnostics?.noteRpcDone(false);
        reject(new Error(`send failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }

  // ─── private ──────────────────────────────────────────────────────────

  private openOnce(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.opts.log?.info?.("ws_connecting", {
        "event.category": "adapter",
        "event.action":   "ws_connect",
        "ws.url":         this.opts.url,
        "ws.headers":     this.opts.headers ? Object.keys(this.opts.headers).join(",") : "(none)",
        "ws.protocols":   Array.isArray(this.opts.protocols)
          ? this.opts.protocols.join(",")
          : this.opts.protocols ?? "(none)",
      });

      let ws: WebSocket;
      try {
        ws = new WebSocket(this.opts.url, this.opts.protocols, {
          ...(this.opts.headers ? { headers: this.opts.headers } : {}),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.opts.log?.error?.("ws_construct_failed", {
          "event.category": "adapter",
          "event.action":   "ws_construct_failed",
          "ws.url":         this.opts.url,
          "error.message":  msg,
        });
        reject(new Error(`WS construct failed: ${msg}`));
        return;
      }

      ws.on("open", async () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.ws = ws;
        this.opts.diagnostics?.noteConnect();
        this.opts.log?.info?.("ws_open", {
          "event.category": "adapter",
          "event.action":   "ws_open",
          "ws.url":         this.opts.url,
        });
        try {
          await this.opts.onOpen?.();
          resolve();
        } catch (e) {
          this.opts.log?.warn?.("onOpen handshake failed", {
            "event.category": "adapter",
            "event.action":   "ws_handshake_failed",
            "error.message":  e instanceof Error ? e.message : String(e),
          });
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });

      ws.on("message", (data: WebSocket.RawData) => {
        // Normalise to ArrayBuffer or string for the decoder. Buffer
        // is the common case in Node/`ws`; copy into a fresh
        // ArrayBuffer rather than slicing .buffer (which can be a
        // SharedArrayBuffer for typed-array views, and which may
        // contain unrelated bytes outside [byteOffset, byteOffset+len)).
        if (typeof data === "string") {
          this.handleFrame(data);
        } else if (data instanceof ArrayBuffer) {
          this.handleFrame(data);
        } else if (Buffer.isBuffer(data)) {
          const ab = new ArrayBuffer(data.byteLength);
          new Uint8Array(ab).set(data);
          this.handleFrame(ab);
        } else {
          // Array of Buffers (fragmented). Concatenate to a single ArrayBuffer.
          const concat = Buffer.concat(data as Buffer[]);
          const ab = new ArrayBuffer(concat.byteLength);
          new Uint8Array(ab).set(concat);
          this.handleFrame(ab);
        }
      });

      ws.on("close", (code: number, reason: Buffer) => {
        const reasonStr = reason.toString() || "(none)";
        this.connected = false;
        this.opts.diagnostics?.noteDisconnect();
        this.opts.log?.warn?.("ws_close", {
          "event.category": "adapter",
          "event.action":   "ws_close",
          "ws.url":         this.opts.url,
          "ws.close_code":  code,
          "ws.close_reason": reasonStr,
        });
        this.opts.onClose?.({ code, reason: reasonStr });
        this.failAllPending(new Error(`WS closed: ${code} ${reasonStr}`));
        if (!this.stopped) this.scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        // `ws` emits real Error objects (not browser ErrorEvent). The
        // .code field is set for things like ENOTFOUND, ECONNREFUSED,
        // ETIMEDOUT. .message has the human-readable cause.
        const code = (err as Error & { code?: string }).code;
        const fields: Record<string, unknown> = {
          "event.category":     "adapter",
          "event.action":       "ws_error",
          "ws.url":             this.opts.url,
          "error.message":      err.message || "unknown WS error",
          "error.stack_trace":  err.stack,
        };
        if (code) fields["error.code"] = code;

        if (!this.connected) {
          this.opts.log?.error?.("ws_error_before_open", fields);
          reject(new Error(
            `WS error before open: ${err.message || "unknown"}` +
            (code ? ` (${code})` : "") +
            ` — url=${this.opts.url}`));
        } else {
          this.opts.log?.warn?.("ws_error", fields);
        }
      });

      // Upgrade-rejected: the HTTP upgrade returned non-101 (401, 403,
      // 404, 502...). This is the auth/permission failure path — without
      // it we'd only see a generic "ws_close".
      // NB: Bun's ws-shim does not currently implement this event;
      // under Bun, failures still surface via ws_close + ws_error.
      ws.on("unexpected-response", (_req, res) => {
        this.opts.log?.error?.("ws_upgrade_rejected", {
          "event.category":            "adapter",
          "event.action":              "ws_upgrade_rejected",
          "ws.url":                    this.opts.url,
          "http.response.status_code": res.statusCode,
          "http.response.status_text": res.statusMessage,
        });
      });
    });
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt += 1;
    this.opts.diagnostics?.noteReconnectAttempt();
    const base = this.opts.reconnectBaseMs ?? 500;
    const delay = Math.min(30_000, base * Math.pow(2, this.reconnectAttempt - 1));
    this.opts.log?.debug?.("ws_reconnect_scheduled", {
      "event.category": "adapter",
      "event.action":   "ws_reconnect_scheduled",
      "ws.url":         this.opts.url,
      "delay_ms":       delay,
      "attempt":        this.reconnectAttempt,
    });
    setTimeout(() => {
      if (this.stopped) return;
      this.openOnce().catch((e) => this.opts.log?.warn?.("reconnect failed", {
        "event.category": "adapter",
        "event.action":   "ws_reconnect_failed",
        "error.message":  e instanceof Error ? e.message : String(e),
      }));
    }, delay);
  }

  private handleFrame(raw: string | ArrayBuffer): void {
    let decoded: Decoded;
    try {
      decoded = this.opts.decodeFrame(raw);
    } catch (e) {
      this.opts.log?.warn?.("decodeFrame threw", {
        "event.category": "adapter",
        "event.action":   "decode_failed",
        "error.message":  e instanceof Error ? e.message : String(e),
      });
      return;
    }

    switch (decoded.kind) {
      case "resp": {
        const p = this.pending.get(decoded.corrId);
        if (!p) return; // stale or unknown
        this.pending.delete(decoded.corrId);
        clearTimeout(p.timeout);
        if (decoded.error) {
          this.opts.diagnostics?.noteRpcDone(false);
          p.reject(new Error(decoded.error.message));
        } else {
          this.opts.diagnostics?.noteRpcDone(true);
          p.resolve(decoded.result);
        }
        return;
      }
      case "event": {
        this.opts.diagnostics?.noteEvent();
        try { this.opts.onEvent(decoded.event); }
        catch (e) { this.opts.log?.warn?.("onEvent handler threw", {
          "event.category": "adapter",
          "event.action":   "on_event_threw",
          "error.message":  e instanceof Error ? e.message : String(e),
        }); }
        return;
      }
      case "pong": {
        this.opts.diagnostics?.noteHeartbeat();
        return;
      }
      case "ignore":
        return;
    }
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timeout);
      this.opts.diagnostics?.noteRpcDone(false);
      p.reject(err);
    }
    this.pending.clear();
  }
}
