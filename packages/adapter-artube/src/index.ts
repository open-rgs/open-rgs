// @open-rgs/adapter-artube
//
// Artube PlatformAdapter for open-rgs.
//
// Wire protocol:
//   - Transport      ws subprotocol "json", auth via headers X-Game-ID /
//                    X-Api-Key. URL is used verbatim — the env var
//                    GamesApiUrl already encodes ?game=<id>.
//   - Handshake      send Hello{supports:{max_schema:1}} on open,
//                    wait for Welcome{use:{max_schema:1}}. RPCs are
//                    refused until Welcome arrives.
//   - Envelope       { proto:1, schema:1, chan, type, id, corr_id?,
//                      op_seq, timestamp, payload }
//   - Channels       rpc | events | control
//   - RPCs           SessionInfoRequest, answered by SessionInfoResponse
//                    PlayRoundRequest, answered by PlayRoundResponse
//                    Errors arrive as type:"Error" with corr_id matching
//                    the request; payload {code, message, details?}
//   - Events         BalanceChanged, SessionClosed, NewConnection
//   - GoAway         control/GoAway closes the WS; if retry_after_ms is
//                    set we wait that long before reconnecting.
//
// Mapping to @open-rgs/contract:
//   PlatformAdapter.openSession  is SessionInfoRequest
//   PlatformAdapter.settleSimple is PlayRoundRequest
//   PlatformAdapter.{openComplex,updateComplex,closeComplex}
//                                are not supported (one-shot protocol).
//                                   Throws E_NOT_SUPPORTED rather than
//                                   silently no-oping.
//   BalanceChanged event         becomes PlatformEvent{type:"balanceChanged"}
//   SessionClosed  event         becomes PlatformEvent{type:"sessionClosed"}
//
// NDA: this repo is private. The wire shape lives here; nothing leaks
// into the MIT @open-rgs/* tree.

import WebSocket from "ws";
import type {
  PlatformAdapter, PlatformEvent,
  SessionInfo, SettleSimple, OpenComplex, UpdateComplex, CloseComplex,
  RoundReceipt, PromoFreeRounds,
} from "@open-rgs/contract";
import { createLogger, type Logger } from "@open-rgs/log";
import pkg from "../package.json" with { type: "json" };

/** Version of this adapter package — exported so consumers can log it
 *  alongside their own boot banner. The same string is stamped as
 *  `service.version` on every line the adapter writes via its default
 *  logger, so you can grep `service.name="open-rgs-adapter-artube"` and
 *  see exactly which adapter is running in the pod. */
export const ARTUBE_ADAPTER_VERSION: string = pkg.version;

// ── Wire types ────────────────────────────────────────────────────────

type Channel = "rpc" | "events" | "control";

interface Envelope<T = unknown> {
  proto: 1;
  schema: 1;
  chan: Channel;
  type: string;
  id: string;
  corr_id?: string;
  op_seq: number;
  timestamp: string;
  payload: T;
}

interface HelloPayload   { supports: { max_schema: number } }
interface WelcomePayload { use:      { max_schema: number } }
interface GoAwayPayload  { reason: string; retry_after_ms?: number }

interface SessionInfoRequestPayload {
  session_id: string;
  player_connection_info: { player_connection_id?: string };
}
interface ArtubeFreeRoundCampaign {
  campaign_id: string;
  rounds_total: number;
  rounds_left: number;
  valid_from: string;
  valid_to: string;
  bet: number;
  total_win: number;
  is_complete: boolean;
}
interface ArtubeGameSettings {
  default_bet_index: number;
  allowed_bets: number[];
  available_auto_spin_counts: number[];
  rtp_options: Array<{ rtp: number; game_mode: string; volatility?: string }>;
  locales: string[];
}
interface ArtubeLastRound {
  round_id: string;
  price_multiplier: number;
  bet_index: number;
  win_multiplier: number;
  win: number;
  free_round_campaign_id?: string;
  started_at: string;
  finished_at: string;
  round_version: number;
  round_state_version: string;
  round_state: string;
  is_platform_max_win_reached: boolean;
}
interface SessionInfoResponsePayload {
  security_hash: string;
  currency: string;
  balance: number;
  last_round?: ArtubeLastRound;
  game_settings: ArtubeGameSettings;
  free_round_campaign?: ArtubeFreeRoundCampaign;
}

interface PlayRoundRequestPayload {
  session_id: string;
  price_multiplier: number;
  bet_index: number;
  win_multiplier: number;
  free_round_campaign_id?: string;
  previous_round_id?: string;
  round_state_version: string;
  round_state: string;
}
interface PlayRoundResponsePayload {
  round_id: string;
  balance: number;
  win: number;
  free_round_campaign?: {
    rounds_left: number;
    total_win: number;
    is_complete: boolean;
  };
  is_platform_max_win_reached: boolean;
}

interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface BalanceChangedPayload  { session_id: string; balance: number; reason: string }
interface SessionClosedPayload   { session_id: string; reason: string }

// ── Public options ────────────────────────────────────────────────────

export interface ArtubeAdapterOptions {
  /** Game id Artube uses to route requests. Sent in the X-Game-ID header. */
  gameId: string;
  /** Artube Games-API WS endpoint, used VERBATIM. The env var GamesApiUrl
   *  already encodes the ?game=<id> query parameter; we don't touch it. */
  wsUrl: string;
  /** Auth token. Sent in the X-Api-Key header. Required by production
   *  Games-API; some local dev environments accept missing. */
  authToken?: string;
  /** Reconnect base delay in ms. Doubled each attempt, capped 30s. Default 2000. */
  reconnectBaseMs?: number;
  /** Per-request RPC deadline. Default 30s. */
  rpcTimeoutMs?: number;
  /** Handshake deadline, from Hello sent to Welcome received. Default 10s. */
  handshakeTimeoutMs?: number;
  /** Cap on reconnect attempts before giving up. Default 20. */
  maxReconnectAttempts?: number;
  /** WS PING interval in ms. Default 20s. Set 0 to disable heartbeat. */
  heartbeatIntervalMs?: number;
  /** Treat the connection as a zombie if no PONG (or any inbound frame)
   *  arrives within this many ms — terminate + reconnect. Default 60s
   *  (3× the default interval). */
  heartbeatTimeoutMs?: number;
  /** Optional logger. If omitted, the adapter constructs its own
   *  via @open-rgs/log's createLogger. Pass your server-core logger
   *  here to get artube lines into the same sink/format as everything
   *  else. */
  logger?: Logger;
}

// ── Adapter ──────────────────────────────────────────────────────────

interface PendingRpc {
  type: string;
  sentAt: number;
  resolve: (env: Envelope) => void;
  reject:  (err: Error) => void;
}

export class ArtubeAdapter implements PlatformAdapter {
  private ws: WebSocket | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject:  ((e: Error) => void) | null = null;

  private readonly pending = new Map<string, PendingRpc>();
  private readonly eventHandlers: ((e: PlatformEvent) => void)[] = [];

  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectAttemptCount = 0;
  private lastError = "";

  // ── Heartbeat / zombie detection ─────────────────────────────────────
  // Bun on long-lived TLS sockets behind an LB has been observed to keep
  // a WebSocket in readyState=OPEN long after the peer side is gone —
  // the pod's adapter looks "connected" but every RPC times out and no
  // GoAway / close ever arrives. We send WS PING frames on an interval
  // and listen for PONG; if no PONG arrives within heartbeatTimeoutMs we
  // assume the connection is a zombie, call terminate() (skip the close
  // handshake, force a 1006 + reconnect). Application-layer idle
  // timeouts at the Artube side are separate — these pings keep our
  // view of the socket honest, they do NOT reset Artube's IdleTimeout.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  // Diagnostic counters
  private totalRpcsSent = 0;
  private totalRpcsOk = 0;
  private totalRpcsFailed = 0;

  // Envelope op_seq counter (resets on each new connection)
  private opSeqCounter = 0;

  private readonly gameId: string;
  private readonly apiKey: string | undefined;
  private readonly wsUrl: string;
  private readonly rpcTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly log: Logger;

  constructor(opts: ArtubeAdapterOptions) {
    if (!opts.gameId) throw new Error("ArtubeAdapter: gameId required");
    if (!opts.wsUrl)  throw new Error("ArtubeAdapter: wsUrl required");

    this.gameId             = opts.gameId;
    this.apiKey             = opts.authToken;
    this.wsUrl              = opts.wsUrl;
    this.rpcTimeoutMs       = opts.rpcTimeoutMs       ?? 30_000;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.reconnectBaseMs    = opts.reconnectBaseMs    ?? 2_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 20;
    this.heartbeatIntervalMs  = opts.heartbeatIntervalMs  ?? 20_000;
    this.heartbeatTimeoutMs   = opts.heartbeatTimeoutMs   ?? 60_000;

    // Caller can hand us a server-core logger so everything flows
    // through one sink/format. Default keeps the adapter usable on
    // its own (tests, dev probes). We stamp the logger's
    // service.version with this package's actual version (read from
    // package.json at bundle time) so every adapter log line carries
    // the running adapter version — answers "which adapter is in the
    // pod right now" without bumping into the ambiguity that hardcoded
    // logger labels created.
    this.log = opts.logger ?? createLogger({
      service: "open-rgs-adapter-artube",
      version: ARTUBE_ADAPTER_VERSION,
    });

    // Single-shot init banner so the boot log has a clear "this adapter
    // is alive at this version with this config" line. Heartbeat is
    // silent by design (every 20s would be noise), so this is your
    // only confirmation it's configured at all until a timeout fires.
    this.log.info("ArtubeAdapter initialised", {
      "event.category": "artube",
      "event.action":   "adapter_init",
      "artube.package_version":      ARTUBE_ADAPTER_VERSION,
      "artube.game_id":              this.gameId,
      "artube.endpoint":             this.wsUrl,
      "artube.heartbeat_interval_ms": this.heartbeatIntervalMs,
      "artube.heartbeat_timeout_ms":  this.heartbeatTimeoutMs,
      "artube.rpc_timeout_ms":        this.rpcTimeoutMs,
      "artube.handshake_timeout_ms":  this.handshakeTimeoutMs,
      "artube.reconnect_base_ms":     this.reconnectBaseMs,
      "artube.max_reconnect_attempts": this.maxReconnectAttempts,
    });
  }

  // ── PlatformAdapter surface ────────────────────────────────────────

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return this.openOnce();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try { this.ws?.close(1000, "shutdown"); }
    catch (e) {
      this.log.warn("ArtubeAdapter close threw", {
        "event.category": "artube",
        "event.action":   "ws_close_threw",
        "error.message":  e instanceof Error ? e.message : String(e),
      });
    }
    this.failAllPending(new Error("ArtubeAdapter disconnected"));
  }

  get isHealthy(): boolean { return this.ready; }

  get diagnostics(): Record<string, unknown> {
    return {
      adapter:                "artube",
      game_id:                this.gameId,
      endpoint:               this.wsUrl,
      auth_present:           !!this.apiKey,
      is_ready:               this.ready,
      ws_state:               this.wsStateString(),
      total_connect_attempts: this.connectAttemptCount,
      reconnect_attempts:     this.reconnectAttempts,
      pending_rpcs:           this.pending.size,
      total_rpcs_sent:        this.totalRpcsSent,
      total_rpcs_ok:          this.totalRpcsOk,
      total_rpcs_failed:      this.totalRpcsFailed,
      last_error:             this.lastError || undefined,
      heartbeat_interval_ms:  this.heartbeatIntervalMs,
      heartbeat_timeout_ms:   this.heartbeatTimeoutMs,
      heartbeat_silent_ms:    this.lastPongAt ? Date.now() - this.lastPongAt : null,
    };
  }

  onEvent(handler: (e: PlatformEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  async openSession(sessionId: string, connectionId: string): Promise<SessionInfo> {
    const env = await this.rpc<SessionInfoRequestPayload, SessionInfoResponsePayload>(
      "SessionInfoRequest",
      {
        session_id: sessionId,
        player_connection_info: { player_connection_id: connectionId },
      },
    );
    return artubeSessionToContract(sessionId, env.payload);
  }

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    // Artube's PlayRoundRequest validator requires round_state to be a
    // non-empty string. core ≥0.3.0's orchestrator now always sends a
    // non-empty envelope (math carry, or a synthesised {type,multiplier,
    // win,bet,bet_index} JSON when carry is absent), so we just pass
    // req.roundState through.
    const payload: PlayRoundRequestPayload = {
      session_id:          req.sessionId,
      price_multiplier:    req.priceMultiplier,
      bet_index:           req.betIndex,
      win_multiplier:      req.multiplier,
      ...(req.promoId ? { free_round_campaign_id: req.promoId } : {}),
      round_state_version: req.mathVersion ?? "1",
      round_state:         req.roundState,
    };
    const env = await this.rpc<PlayRoundRequestPayload, PlayRoundResponsePayload>(
      "PlayRoundRequest",
      payload,
    );
    return artubePlayRoundToReceipt(env.payload);
  }

  // Artube Games-API is a one-shot PlayRound. There is no debit-only
  // open + step + credit-only close shape. Fail loudly instead of pretending.
  async openComplex(_: OpenComplex): Promise<RoundReceipt> {
    throw new Error("ArtubeAdapter: complex rounds are not supported by Artube Games-API (one-shot PlayRound only)");
  }
  async updateComplex(_: UpdateComplex): Promise<void> {
    throw new Error("ArtubeAdapter: complex rounds are not supported by Artube Games-API");
  }
  async closeComplex(_: CloseComplex): Promise<RoundReceipt> {
    throw new Error("ArtubeAdapter: complex rounds are not supported by Artube Games-API");
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  private openOnce(): Promise<void> {
    this.ready = false;
    this.opSeqCounter = 0;
    this.connectAttemptCount++;

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject  = reject;
    });

    const headers: Record<string, string> = {};
    if (this.gameId) headers["X-Game-ID"] = this.gameId;
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;

    this.log.info("Artube API connecting", {
      "event.category": "artube",
      "event.action":   "ws_connect",
      "artube.ws_url":  this.wsUrl,
      "artube.game_id": this.gameId,
      "artube.attempt": this.connectAttemptCount,
      "artube.auth_present": !!this.apiKey,
      "artube.header_keys":  Object.keys(headers).join(","),
    });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.wsUrl, ["json"], { headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this.log.error("Artube WS constructor threw", {
        "event.category": "artube",
        "event.action":   "ws_construct_failed",
        "artube.ws_url":  this.wsUrl,
        "error.message":  msg,
      });
      this.readyReject?.(new Error(`WS construct failed: ${msg}`));
      return this.readyPromise!;
    }
    this.ws = ws;

    ws.on("open", () => {
      this.log.info("Artube WS open — sending Hello", {
        "event.category": "artube",
        "event.action":   "ws_open",
        "artube.ws_url":  this.wsUrl,
      });
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      const hello = this.makeEnvelope<HelloPayload>("control", "Hello", {
        supports: { max_schema: 1 },
      });
      this.send(hello);
    });

    ws.on("pong", () => {
      // Refresh the liveness clock. Don't log per pong — too noisy at
      // 20s cadence; we only log when a heartbeat fails or the timeout
      // fires. lastPongAt is also bumped on any inbound message
      // (handleMessage) so app traffic counts as liveness too.
      this.lastPongAt = Date.now();
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString();
      let msg: Envelope;
      try { msg = JSON.parse(text) as Envelope; }
      catch (e) {
        this.log.error("Artube WS JSON parse error", {
          "event.category": "artube",
          "event.action":   "ws_parse_error",
          "error.message":  e instanceof Error ? e.message : String(e),
          "artube.raw_preview": text.slice(0, 200),
        });
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("error", (err: Error) => {
      // `ws` package emits real Error objects, not browser ErrorEvent.
      // The code field is set for things like ENOTFOUND, ECONNREFUSED.
      const code = (err as Error & { code?: string }).code;
      const errMsg = err.message || "unknown WS error";
      this.lastError = errMsg;
      this.log.error("Artube WS error", {
        "event.category": "artube",
        "event.action":   "ws_error",
        "error.message":  errMsg,
        "error.code":     code,
        "error.stack_trace": err.stack,
        "artube.ws_url":  this.wsUrl,
        "artube.ws_state": this.wsStateString(),
      });
    });

    ws.on("unexpected-response", (_req, res) => {
      // Fires when the HTTP upgrade returns a non-101 (401, 403, 404,
      // 502...). This is the auth/permission-failure path — without
      // logging it explicitly we'd just see a generic "WS closed".
      this.log.error("Artube WS upgrade rejected", {
        "event.category": "artube",
        "event.action":   "ws_upgrade_rejected",
        "artube.http_status":      res.statusCode,
        "artube.http_status_text": res.statusMessage,
        "artube.ws_url":           this.wsUrl,
      });
      this.lastError = `HTTP ${res.statusCode} ${res.statusMessage}`;
    });

    ws.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString() || "(none)";
      this.log.warn("Artube WS closed", {
        "event.category": "artube",
        "event.action":   "ws_close",
        "artube.close_code":   code,
        "artube.close_reason": reasonStr,
        "artube.was_ready":    this.ready,
        "artube.pending_rpcs": this.pending.size,
        "artube.last_error":   this.lastError || undefined,
      });
      this.ready = false;
      this.stopHeartbeat();

      if (this.readyReject) {
        this.readyReject(new Error(
          `Artube WS closed before Welcome (code=${code} reason=${reasonStr}` +
          (this.lastError ? ` last_error=${this.lastError}` : "") + ")"));
        this.readyResolve = null;
        this.readyReject  = null;
      }

      this.failAllPending(new Error(`WS closed (code=${code})`));

      if (this.shouldReconnect) this.scheduleReconnect();
    });

    // Hello/Welcome handshake deadline
    const handshakeTimer = setTimeout(() => {
      if (!this.ready && this.readyReject) {
        this.log.error("Artube handshake timeout — no Welcome received", {
          "event.category": "artube",
          "event.action":   "ws_handshake_timeout",
          "artube.timeout_ms": this.handshakeTimeoutMs,
          "artube.ws_state":   this.wsStateString(),
        });
        this.readyReject(new Error(`Artube handshake timeout (${this.handshakeTimeoutMs}ms)`));
        this.readyResolve = null;
        this.readyReject  = null;
        try { ws.close(); } catch { /* best-effort */ }
      }
    }, this.handshakeTimeoutMs);

    return this.readyPromise.finally(() => clearTimeout(handshakeTimer));
  }

  private scheduleReconnect(delayMsOverride?: number): void {
    // GoAway handler schedules first (with retry_after_ms), then closes
    // the WS, which fires 'close' which would schedule a SECOND timer
    // unless we guard here. Without this guard the second timer fires
    // ~ms after the first, producing two parallel WS connections and an
    // orphan Error reply that doesn't match any in-flight RPC. First
    // schedule wins; subsequent calls until the timer fires are no-ops.
    if (this.reconnectTimer !== null) {
      this.log.debug("Artube reconnect already scheduled — dropping duplicate", {
        "event.category": "artube",
        "event.action":   "ws_reconnect_duplicate",
        "artube.attempt": this.reconnectAttempts,
      });
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error("Artube max reconnect attempts reached — giving up", {
        "event.category": "artube",
        "event.action":   "ws_reconnect_exhausted",
        "artube.max_attempts": this.maxReconnectAttempts,
      });
      this.shouldReconnect = false;
      return;
    }
    this.reconnectAttempts++;
    const delay = delayMsOverride
      ?? Math.min(30_000, this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts - 1));
    this.log.info("Artube scheduling reconnect", {
      "event.category": "artube",
      "event.action":   "ws_reconnect_scheduled",
      "artube.attempt": this.reconnectAttempts,
      "artube.delay_ms": delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openOnce().catch(err => {
        this.log.warn("Artube reconnect attempt failed", {
          "event.category": "artube",
          "event.action":   "ws_reconnect_failed",
          "error.message":  err instanceof Error ? err.message : String(err),
        });
      });
    }, delay);
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  private startHeartbeat(): void {
    if (this.heartbeatIntervalMs === 0) return;  // disabled
    this.stopHeartbeat();  // belt-and-braces
    this.lastPongAt = Date.now();  // fresh budget on every (re)connect
    this.heartbeatTimer = setInterval(() => this.tickHeartbeat(), this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private tickHeartbeat(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Socket isn't OPEN — nothing to ping. The close handler will
      // stopHeartbeat() when it fires; this is just defensive.
      return;
    }
    const silentMs = Date.now() - this.lastPongAt;
    if (silentMs > this.heartbeatTimeoutMs) {
      this.log.warn("Artube WS heartbeat timeout — terminating zombie connection", {
        "event.category": "artube",
        "event.action":   "ws_heartbeat_timeout",
        "artube.silent_ms":           silentMs,
        "artube.heartbeat_timeout_ms": this.heartbeatTimeoutMs,
        "artube.ws_state":            this.wsStateString(),
        "artube.pending_rpcs":        this.pending.size,
      });
      // terminate() skips the TCP/TLS close handshake — the right move
      // when the peer is unresponsive. ws fires 'close' with code 1006
      // immediately, which schedules a reconnect.
      try { this.ws.terminate(); }
      catch (e) {
        this.log.warn("Artube WS terminate threw", {
          "event.category": "artube",
          "event.action":   "ws_terminate_threw",
          "error.message":  e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    try { this.ws.ping(); }
    catch (e) {
      // Bun's ws polyfill has been spotty on some methods historically;
      // log and let the next heartbeat re-attempt. A genuinely dead
      // socket will trip the silent-timeout check above.
      this.log.warn("Artube WS ping send failed", {
        "event.category": "artube",
        "event.action":   "ws_ping_failed",
        "error.message":  e instanceof Error ? e.message : String(e),
      });
    }
  }

  // ── Inbound dispatch ────────────────────────────────────────────────

  private handleMessage(msg: Envelope): void {
    // Any inbound application frame is proof the peer is alive — refresh
    // the liveness clock so we don't terminate a busy connection that
    // happens to skip a PONG window (some intermediaries drop control
    // frames under load).
    this.lastPongAt = Date.now();

    this.log.debug("Artube recv", {
      "event.category": "artube",
      "event.action":   "ws_recv",
      "artube.chan":    msg.chan,
      "artube.type":    msg.type,
      "artube.id":      msg.id,
      "artube.corr_id": msg.corr_id,
    });

    // Control channel: Welcome / GoAway
    if (msg.chan === "control") {
      if (msg.type === "Welcome") {
        const wp = msg.payload as WelcomePayload;
        this.log.info("Artube handshake complete — Welcome received", {
          "event.category": "artube",
          "event.action":   "ws_welcome",
          "artube.use_schema": wp.use?.max_schema,
        });
        this.ready = true;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject  = null;
        return;
      }
      if (msg.type === "GoAway") {
        const gp = msg.payload as GoAwayPayload;
        this.log.warn("Artube GoAway received", {
          "event.category": "artube",
          "event.action":   "ws_goaway",
          "artube.reason":  gp.reason,
          "artube.retry_after_ms": gp.retry_after_ms,
        });
        this.ready = false;
        try { this.ws?.close(); } catch { /* best-effort */ }
        if (this.shouldReconnect && gp.retry_after_ms !== undefined) {
          this.scheduleReconnect(gp.retry_after_ms);
        }
        return;
      }
      this.log.warn("Artube unknown control message", {
        "event.category": "artube",
        "event.action":   "ws_unknown_control",
        "artube.type":    msg.type,
      });
      return;
    }

    // Events channel: BalanceChanged / SessionClosed / NewConnection
    if (msg.chan === "events") {
      this.dispatchEvent(msg);
      return;
    }

    // RPC responses (chan == "rpc"): match by corr_id
    if (msg.corr_id && this.pending.has(msg.corr_id)) {
      const p = this.pending.get(msg.corr_id)!;
      this.pending.delete(msg.corr_id);
      const rpcMs = Math.round(performance.now() - p.sentAt);

      if (msg.type === "Error") {
        const ep = msg.payload as ErrorPayload;
        this.totalRpcsFailed++;
        this.log.error("Artube RPC error response", {
          "event.category": "artube",
          "event.action":   "rpc_error",
          "artube.rpc_type":   p.type,
          "artube.corr_id":    msg.corr_id,
          "artube.error_code": ep.code,
          "error.message":     ep.message,
          "artube.rpc_ms":     rpcMs,
        });
        p.reject(new Error(`Artube ${ep.code}: ${ep.message}`));
      } else {
        this.totalRpcsOk++;
        this.log.info("Artube RPC ok", {
          "event.category": "artube",
          "event.action":   "rpc_ok",
          "artube.rpc_type":   p.type,
          "artube.corr_id":    msg.corr_id,
          "artube.rpc_ms":     rpcMs,
        });
        p.resolve(msg);
      }
      return;
    }

    this.log.warn("Artube message with no matching corr_id", {
      "event.category": "artube",
      "event.action":   "ws_orphan_msg",
      "artube.chan":    msg.chan,
      "artube.type":    msg.type,
      "artube.corr_id": msg.corr_id,
    });
  }

  private dispatchEvent(msg: Envelope): void {
    let translated: PlatformEvent | null = null;
    switch (msg.type) {
      case "BalanceChanged": {
        const p = msg.payload as BalanceChangedPayload;
        translated = { type: "balanceChanged", sessionId: p.session_id, balance: p.balance, reason: p.reason };
        break;
      }
      case "SessionClosed": {
        const p = msg.payload as SessionClosedPayload;
        translated = { type: "sessionClosed", sessionId: p.session_id, reason: p.reason };
        break;
      }
      case "NewConnection": {
        // No direct mapping in open-rgs contract; log and drop.
        this.log.info("Artube NewConnection event (no contract mapping)", {
          "event.category": "artube",
          "event.action":   "event_new_connection",
          "artube.payload": msg.payload,
        });
        return;
      }
      default:
        this.log.warn("Artube unknown event type", {
          "event.category": "artube",
          "event.action":   "event_unknown",
          "artube.type":    msg.type,
        });
        return;
    }
    for (const h of this.eventHandlers) {
      try { h(translated); }
      catch (e) {
        this.log.warn("PlatformEvent handler threw", {
          "event.category": "artube",
          "event.action":   "event_handler_threw",
          "error.message":  e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  // ── RPC primitive ───────────────────────────────────────────────────

  private async rpc<Req, Res>(type: string, payload: Req): Promise<Envelope<Res>> {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      this.log.error("Artube RPC refused — not ready", {
        "event.category": "artube",
        "event.action":   "rpc_refused",
        "artube.rpc_type": type,
        "artube.ws_state": this.wsStateString(),
        "artube.is_ready": this.ready,
      });
      throw new Error(`Artube not connected (rpc=${type} ws_state=${this.wsStateString()})`);
    }

    const env = this.makeEnvelope<Req>("rpc", type, payload);
    this.totalRpcsSent++;

    this.log.info("Artube RPC sent", {
      "event.category": "artube",
      "event.action":   "rpc_sent",
      "artube.rpc_type": type,
      "artube.msg_id":   env.id,
      "artube.timeout_ms": this.rpcTimeoutMs,
    });

    return new Promise<Envelope<Res>>((resolve, reject) => {
      const sentAt = performance.now();
      const timer = setTimeout(() => {
        this.pending.delete(env.id);
        this.totalRpcsFailed++;
        this.log.error("Artube RPC timeout", {
          "event.category": "artube",
          "event.action":   "rpc_timeout",
          "artube.rpc_type": type,
          "artube.msg_id":   env.id,
          "artube.timeout_ms": this.rpcTimeoutMs,
        });
        reject(new Error(`Artube RPC timeout: ${type} (${this.rpcTimeoutMs}ms)`));
      }, this.rpcTimeoutMs);

      this.pending.set(env.id, {
        type,
        sentAt,
        resolve: (m) => { clearTimeout(timer); resolve(m as Envelope<Res>); },
        reject:  (e) => { clearTimeout(timer); reject(e); },
      });
      this.send(env);
    });
  }

  private send(env: Envelope): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log.error("Artube send attempted while WS not open", {
        "event.category": "artube",
        "event.action":   "ws_send_failed",
        "artube.msg_type": env.type,
        "artube.ws_state": this.wsStateString(),
      });
      return;
    }
    const json = JSON.stringify(env);
    this.log.debug("Artube send", {
      "event.category": "artube",
      "event.action":   "ws_send",
      "artube.chan":    env.chan,
      "artube.type":    env.type,
      "artube.id":      env.id,
      "artube.bytes":   json.length,
    });
    this.ws.send(json);
  }

  private makeEnvelope<T>(chan: Channel, type: string, payload: T): Envelope<T> {
    return {
      proto: 1, schema: 1, chan, type,
      id:        crypto.randomUUID(),
      op_seq:    ++this.opSeqCounter,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) {
      this.totalRpcsFailed++;
      p.reject(err);
    }
    this.pending.clear();
  }

  private wsStateString(): string {
    if (!this.ws) return "null";
    return ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][this.ws.readyState] ?? String(this.ws.readyState);
  }
}

// ── Wire-to-contract translators ────────────────────────────────────

function artubeSessionToContract(
  sessionId: string,
  p: SessionInfoResponsePayload,
): SessionInfo {
  const info: SessionInfo = {
    sessionId,
    currency:        p.currency,
    // Artube wire amounts are minor units of a 2-decimal currency
    // (EUR/USD/RUB-class). The wire schema does not carry a
    // precision field — if Artube ever supports JPY (0) or BTC (8),
    // this needs to become per-currency lookup or per-session metadata.
    currencyDecimals: 2,
    balance:         p.balance,
    allowedBets:     p.game_settings.allowed_bets,
    defaultBetIndex: p.game_settings.default_bet_index,
  };
  if (p.free_round_campaign && !p.free_round_campaign.is_complete) {
    info.promo = artubeCampaignToPromo(p.free_round_campaign);
  }
  if (p.last_round) {
    info.carry       = p.last_round.round_state;
    info.mathVersion = String(p.last_round.round_version);
  }
  return info;
}

/** Map Artube's FreeRoundCampaign wire shape into the contract's
 *  neutral PromoFreeRounds. The Artube-specific tracking fields
 *  (total_win, is_complete, valid_from) stay inside this adapter —
 *  the platform's bonus engine owns those numbers, not the RGS. */
function artubeCampaignToPromo(c: ArtubeFreeRoundCampaign): PromoFreeRounds {
  return {
    id:        c.campaign_id,
    bet:       c.bet,
    remaining: c.rounds_left,
    total:     c.rounds_total,
    validTo:   c.valid_to,
  };
}

function artubePlayRoundToReceipt(p: PlayRoundResponsePayload): RoundReceipt {
  const receipt: RoundReceipt = {
    roundId: p.round_id,
    balance: p.balance,
  };
  if (p.free_round_campaign) {
    receipt.promo = { remaining: p.free_round_campaign.rounds_left };
  }
  return receipt;
}
