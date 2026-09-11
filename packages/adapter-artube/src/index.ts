// @open-rgs/adapter-artube
//
// Artube PlatformAdapter for open-rgs.
//
// Wire protocol:
//   - Transport      ws subprotocol "json", auth via headers X-Game-ID /
//                    X-Api-Key. URL is used verbatim, the env var
//                    GamesApiUrl already encodes ?game=<id>.
//   - Handshake      send Hello{supports:{max_schema:1}} on open,
//                    wait for Welcome{use:{max_schema:1}}. RPCs are
//                    refused until Welcome arrives.
//   - Envelope       { proto:1, schema:1, chan, type, id, corr_id?,
//                      op_seq, timestamp, payload }
//   - Channels       rpc | events | control
//   - RPCs           SessionInfoRequest, answered by SessionInfoResponse
//                    PlayRoundRequest, answered by PlayRoundResponse
//                    OpenRoundRequest / UpdateRoundStateRequest /
//                    CloseRoundRequest / AutocloseRoundRequest, the
//                    complex-round (interactive) trio plus the
//                    platform-initiated close.
//                    Errors arrive as type:"Error" with corr_id matching
//                    the request; payload {code, message, details?}
//   - Events         BalanceChanged, SessionClosed, NewConnection,
//                    AutocloseRequest (with or without an `Event` suffix,
//                    both spellings appear in Artube's docs).
//   - GoAway         control/GoAway closes the WS; if retry_after_ms is
//                    set we wait that long before reconnecting.
//
// Mapping to @open-rgs/contract:
//   PlatformAdapter.openSession    is SessionInfoRequest
//   PlatformAdapter.settleSimple   is PlayRoundRequest
//   PlatformAdapter.openComplex    is OpenRoundRequest
//   PlatformAdapter.updateComplex  is UpdateRoundStateRequest
//   PlatformAdapter.closeComplex   is CloseRoundRequest, or
//                                  AutocloseRoundRequest when the close
//                                  carries a `reason` (platform-initiated).
//   BalanceChanged event           becomes PlatformEvent{type:"balanceChanged"}
//   SessionClosed  event           becomes PlatformEvent{type:"sessionClosed"}
//   AutocloseRequest event         becomes PlatformEvent{type:"autocloseRequested"}
//
// Two things the wire forces on this adapter, both handled here rather
// than pushed onto every game:
//
//   Amounts are major units. Artube speaks `150.75`; open-rgs money is
//   integer minor units. Everything inbound (balance, allowed_bets,
//   BalanceChanged) is scaled by 10^currencyDecimals, taken from
//   `game_settings.currency_minimal_unit` when the wallet sends it.
//   Nothing outbound needs scaling: this wire is amount-blind.
//
//   One round_state slot, two pieces of state. A complex close carries
//   BOTH this round's final state and the cross-round carry, and the
//   wallet stores exactly one opaque string. We pack them into one
//   marked envelope (see packRoundState) and unpack on openSession, so
//   the audit record keeps the real final state instead of losing it to
//   the carry.
//
// NOT PUBLISHED. This package lives in the monorepo for the workspace, the
// typecheck and the conformance run, and is marked `private` so `changeset
// publish` never picks it up - it is also on the changesets ignore list, so a
// changeset cannot version it by accident. The wire shape stays here; nothing
// about it leaks into the published @open-rgs/* packages, the specs or the
// docs site, which stay wallet-neutral (CLAUDE.md).

import WebSocket from "ws";
import type {
  PlatformAdapter, PlatformEvent,
  SessionInfo, SettleSimple, OpenComplex, UpdateComplex, CloseComplex,
  RoundReceipt, PromoFreeRounds,
} from "@open-rgs/contract";
import { createLogger, type Logger } from "@open-rgs/log";
import pkg from "../package.json" with { type: "json" };

/** Version of this adapter package, exported so consumers can log it
 *  alongside their own boot banner. The same string is stamped as
 *  `service.version` on every line the adapter writes via its default
 *  logger, so you can grep `service.name="open-rgs-adapter-artube"` and
 *  see exactly which adapter is running in the pod. */
export const ARTUBE_ADAPTER_VERSION: string = pkg.version;

/** A round the WALLET says is still open on a session.
 *
 *  The recovery gap, in one shape. A round is opened - and debited - by one
 *  process; that process dies, or the pod rolls, or the player comes back on
 *  another instance. The RGS has no memory of the round, the wallet still
 *  does, and every subsequent round on that session is refused with
 *  `InvalidRoundOperation: Round is already opened`. The player is stuck
 *  until someone closes it by hand.
 *
 *  Artube's SessionInfo answers the question the open-rgs contract cannot ask
 *  yet (ADR-007): `last_round` with no `finished_at` IS the open round, with
 *  the state, the version and the price it was opened at. The adapter surfaces
 *  it here, and adopts the round so a close for it works. What to settle it
 *  at is the game's decision, not the adapter's - it owns the math that can
 *  value the state. */
export interface ArtubeOpenRound {
  roundId: string;
  /** The round's state as the wallet last stored it. `ComplexMath.autoclose`
   *  takes exactly this. */
  state: string;
  /** What the round was opened at, so a settle can be priced:
   *  `allowedBets[betIndex] * priceMultiplier`. */
  betIndex: number;
  priceMultiplier: number;
  /** Math version that wrote the state, when the wire carried one. A state
   *  written by math that is no longer loaded must not be valued by the math
   *  that replaced it. */
  mathVersion?: string;
  startedAt?: string;
}

// ── Wire types ────────────────────────────────────────────────────────

type Channel = "rpc" | "events" | "control";

interface Envelope<T = unknown> {
  proto: 1;
  /** Negotiated at Hello. 1 unless the adapter was configured for 2. */
  schema: number;
  chan: Channel;
  type: string;
  id: string;
  corr_id?: string;
  op_seq: number;
  timestamp: string;
  payload: T;
}

interface HelloPayload {
  supports: {
    max_schema: number;
    /** Schema 2 only: the contract types this backend can handle, and the
     *  version range for each. Artube filters the connection down to this
     *  list, so anything left out is never delivered. */
    contracts?: Record<string, { min: number; max: number }>;
    features?: string[];
  };
}

/** Every contract type this adapter understands, for the schema-2 Hello.
 *  Leaving one out would silently switch off that message for the whole
 *  connection, so the list is exhaustive by construction rather than by
 *  whatever happened to be needed when it was written. */
const DECLARED_CONTRACTS = [
  "SessionInfoRequest", "SessionInfoResponse",
  "PlayRoundRequest", "PlayRoundResponse",
  "OpenRoundRequest", "OpenRoundResponse",
  "UpdateRoundStateRequest", "UpdateRoundStateResponse",
  "CloseRoundRequest", "CloseRoundResponse",
  "AutocloseRoundRequest",
  "Error",
  "BalanceChangedEvent", "SessionClosedEvent",
  "AutocloseRequestEvent", "NewConnectionEvent",
] as const;
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
  /** Smallest representable amount in the session currency (0.01 for a
   *  2-decimal currency, 1 for a 0-decimal one). Optional on the wire;
   *  when absent we fall back to the adapter's `currencyDecimals`. */
  currency_minimal_unit?: number;
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
  /** Absent while the round is still open. */
  finished_at?: string;
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

// -- Complex round: OpenRound -> UpdateRoundState* -> CloseRound --------
//
// `round_version` is the wallet's own per-round operation counter. It is
// computed strictly on the Artube side: open returns it, every update
// returns the next one, and each request must echo the latest one the
// wallet handed back. Send a stale number and the round is refused with
// InvalidRoundOperation, so the adapter tracks it per round rather than
// asking the RGS (which has no concept of it) to carry it.

interface ArtubeFeature { type: string }

interface OpenRoundRequestPayload {
  session_id: string;
  price_multiplier: number;
  bet_index: number;
  free_round_campaign_id?: string;
  previous_round_id?: string;
  features?: ArtubeFeature[];
  round_state_version: string;
  round_state: string;
}
interface OpenRoundResponsePayload {
  round_version: number;
  round_id: string;
  balance: number;
}

interface UpdateRoundStateRequestPayload {
  session_id: string;
  round_id: string;
  round_version: number;
  round_state_version: string;
  round_state: string;
}
interface UpdateRoundStateResponsePayload {
  round_version: number;
}

interface CloseRoundRequestPayload {
  session_id: string;
  round_id: string;
  win_multiplier: number;
  status: "completed" | "cancelled";
  features?: ArtubeFeature[];
  round_version: number;
  round_state_version: string;
  round_state: string;
}
interface CloseRoundResponsePayload {
  balance: number;
  win?: number;
  free_round_campaign?: {
    rounds_left: number;
    total_win: number;
    is_complete: boolean;
  };
  is_platform_max_win_reached?: boolean;
}

/** The platform asking us to finish a round it considers abandoned. It
 *  carries the authoritative `round_version` to answer with, which is why
 *  we stash it before handing the trigger up to the orchestrator. */
interface AutocloseRequestEventPayload {
  session_id: string;
  round_id: string;
  round_version: number;
  round_state_version: string;
  round_state: string;
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
   *  arrives within this many ms, terminate + reconnect. Default 60s
   *  (3× the default interval). */
  heartbeatTimeoutMs?: number;
  /** Optional logger. If omitted, the adapter constructs its own
   *  via @open-rgs/log's createLogger. Pass your server-core logger
   *  here to get artube lines into the same sink/format as everything
   *  else. */
  logger?: Logger;
  /** Fractional digits of the session currency, used to convert Artube's
   *  major-unit amounts (150.75) into the integer minor units open-rgs
   *  counts money in (15075). Only a fallback: when the wallet sends
   *  `game_settings.currency_minimal_unit` that value wins, because it is
   *  per-session and this is not. Default 2. */
  currencyDecimals?: number;
  /** "minor-units" (default) scales every inbound amount as described
   *  above. "verbatim" passes Artube's numbers through untouched - only
   *  correct if your wallet is already configured in minor units, and it
   *  will make `bet` non-integer on a 2-decimal ladder, which the
   *  orchestrator refuses. Escape hatch, not a tuning knob. */
  amountScaling?: "minor-units" | "verbatim";
  /** `round_state_version` sent when the RGS has no math version to stamp
   *  (the orchestrator omits it on a complex open). Default "1". */
  defaultRoundStateVersion?: string;
  /** Hello schema to negotiate. 1 (default) is the flat handshake. 2 adds
   *  the per-contract version declaration - and with it Artube's filter:
   *  a contract type you do not declare is never delivered on that
   *  connection. We declare all 16, so 2 is safe; it is opt-in only
   *  because a wallet that does not speak it closes the socket with
   *  PolicyViolation rather than downgrading. */
  schemaVersion?: 1 | 2;
}

// ── Adapter ──────────────────────────────────────────────────────────

interface PendingRpc {
  type: string;
  sentAt: number;
  resolve: (env: Envelope) => void;
  reject:  (err: Error) => void;
}

/** What the adapter remembers about a round the wallet has open. */
interface OpenRoundBook {
  sessionId: string;
  /** Latest round_version the wallet handed back. */
  version: number;
  /** round_state_version stamped at open; reused when a later request has
   *  no math version of its own, so one round reports one format version. */
  stateVersion: string;
  /** Union of every feature declared so far on this round. */
  features: Set<string>;
  /** Serialises the wallet calls for this round. `updateComplex` is
   *  fire-and-forget in best-effort mode, so two updates can be in flight
   *  at once; each would read the same `version` and the second would be
   *  refused with InvalidRoundOperation. Chaining keeps version reads and
   *  writes in order without a lock the rest of the adapter doesn't need. */
  chain: Promise<unknown>;
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
  // a WebSocket in readyState=OPEN long after the peer side is gone, 
  // the pod's adapter looks "connected" but every RPC times out and no
  // GoAway / close ever arrives. We send WS PING frames on an interval
  // and listen for PONG; if no PONG arrives within heartbeatTimeoutMs we
  // assume the connection is a zombie, call terminate() (skip the close
  // handshake, force a 1006 + reconnect). Application-layer idle
  // timeouts at the Artube side are separate, these pings keep our
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

  // ── Complex-round bookkeeping ────────────────────────────────────────
  // One entry per round that is open on the wallet. `version` is the
  // wallet's round_version, the number every subsequent request on that
  // round must echo; `features` accumulates so the close can send the
  // open-union-close set the docs ask for. The entry dies with the close.
  private readonly rounds = new Map<string, OpenRoundBook>();
  // Rounds the wallet reported open on a session that this process did not
  // open. Keyed by session, replaced on every openSession, cleared when the
  // round is closed.
  private readonly orphans = new Map<string, ArtubeOpenRound>();
  // The wallet's own last_round, verbatim, per session. Diagnostics only.
  private readonly lastRounds = new Map<string, ArtubeLastRound>();
  // Per-session minor-unit scale, learned from SessionInfo. Events carry a
  // balance but no currency metadata, so without this an out-of-band
  // BalanceChanged would arrive in different units than every other amount.
  private readonly sessionScale = new Map<string, number>();

  private readonly currencyDecimals: number;
  private readonly scaleAmounts: boolean;
  private readonly defaultRoundStateVersion: string;
  private readonly schemaVersion: 1 | 2;

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
    this.currencyDecimals     = opts.currencyDecimals     ?? 2;
    this.scaleAmounts         = (opts.amountScaling ?? "minor-units") === "minor-units";
    this.defaultRoundStateVersion = opts.defaultRoundStateVersion ?? "1";
    this.schemaVersion        = opts.schemaVersion        ?? 1;

    // Caller can hand us a server-core logger so everything flows
    // through one sink/format. Default keeps the adapter usable on
    // its own (tests, dev probes). We stamp the logger's
    // service.version with this package's actual version (read from
    // package.json at bundle time) so every adapter log line carries
    // the running adapter version, answers "which adapter is in the
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
      "artube.schema_version":         this.schemaVersion,
      "artube.amount_scaling":         this.scaleAmounts ? "minor-units" : "verbatim",
      "artube.currency_decimals":      this.currencyDecimals,
    });
  }

  // ── PlatformAdapter surface ────────────────────────────────────────

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return this.openOnce();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    // Synchronously, before the socket has finished closing. `ready` was
    // cleared in the close handler, so between calling disconnect() and the
    // event landing the adapter still answered isHealthy: true - and a caller
    // that asks is deciding whether to route a round at it. A machine fast
    // enough to fire close inside the same tick hides this; CI is not.
    this.ready = false;
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
      open_complex_rounds:    this.rounds.size,
      wallet_reported_open_rounds: this.orphans.size,
      schema_version:         this.schemaVersion,
      amount_scaling:         this.scaleAmounts ? "minor-units" : "verbatim",
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
    const scale = this.scaleFor(env.payload.game_settings);
    this.sessionScale.set(sessionId, scale);
    this.adoptOpenRound(sessionId, env.payload.last_round);
    return artubeSessionToContract(sessionId, env.payload, scale, this.currencyDecimals);
  }

  /** The round the wallet says is open on this session and this process did
   *  not open, if any. Populated by the most recent `openSession`. */
  openRoundFor(sessionId: string): ArtubeOpenRound | undefined {
    return this.orphans.get(sessionId);
  }

  /**
   * Exactly what the wallet said its last round was, from the most recent
   * `openSession`.
   *
   * For looking at, not for deciding with. When a session is refused with
   * `Round is already opened` the only question that matters is which round
   * the wallet means, and every field that might answer it - is
   * `finished_at` there, does the state carry the open marker, what is the
   * `round_version` - is otherwise visible only in a log line on a pod you
   * may not be able to read. Contains no secret: it is this player's own
   * round, already theirs to see in the client.
   */
  lastRoundFor(sessionId: string): Readonly<ArtubeLastRound> | undefined {
    return this.lastRounds.get(sessionId);
  }

  /**
   * Claim one round by id, so a close for it can be sent.
   *
   * The last escape hatch, for the case `last_round` cannot reach: a complex
   * round left open while simple rounds kept settling after it. Each of those
   * is its own round, so the open one is not the session's last round and
   * nothing in SessionInfo points at it - but the wallet still refuses every
   * new round with `InvalidRoundOperation: Round is already opened`.
   *
   * The id comes from wherever the open was recorded: this adapter's own
   * `round_open` log line, the operator's back office, a client's replay.
   * `roundVersion` is the wallet's counter for it - 0 for a round that was
   * opened and never updated, which is the usual shape of an abandoned one.
   *
   * Nothing here is inferred, which is the point: an adapter guessing at
   * which round to close is how you settle the wrong one.
   */
  claimRound(sessionId: string, roundId: string, roundVersion = 0, stateVersion?: string): void {
    this.rounds.set(roundId, {
      sessionId,
      version: roundVersion,
      stateVersion: stateVersion ?? this.defaultRoundStateVersion,
      features: new Set(),
      chain: Promise.resolve(),
    });
    this.log.warn("Artube round claimed by id", {
      "event.category": "artube",
      "event.action":   "round_claimed_by_id",
      "artube.session_id":    sessionId,
      "artube.round_id":      roundId,
      "artube.round_version": roundVersion,
    });
  }

  /**
   * Claim `last_round` as open whatever it looks like, and hand it back.
   *
   * The escape hatch for a round the marker cannot identify: written before
   * the marker existed, or by another implementation of this wire. The
   * symptom is unambiguous - every round on the session is refused with
   * `InvalidRoundOperation: Round is already opened` - but the state alone
   * does not say so, and there is no way to ask.
   *
   * Deliberately not automatic. It closes whatever the wallet last recorded,
   * which is wrong if the session is not actually wedged, so it is something
   * an operator invokes with the refusal in front of them.
   */
  async claimLastRound(sessionId: string, connectionId = "claim"): Promise<ArtubeOpenRound | undefined> {
    const env = await this.rpc<SessionInfoRequestPayload, SessionInfoResponsePayload>(
      "SessionInfoRequest",
      { session_id: sessionId, player_connection_info: { player_connection_id: connectionId } },
    );
    const last = env.payload.last_round;
    if (!last) return undefined;
    this.sessionScale.set(sessionId, this.scaleFor(env.payload.game_settings));
    const orphan: ArtubeOpenRound = {
      roundId: last.round_id,
      state: unwrapState(last.round_state),
      betIndex: last.bet_index,
      priceMultiplier: last.price_multiplier,
      ...(last.round_state_version ? { mathVersion: last.round_state_version } : {}),
      ...(last.started_at ? { startedAt: last.started_at } : {}),
    };
    this.orphans.set(sessionId, orphan);
    this.rounds.set(orphan.roundId, {
      sessionId,
      version: last.round_version,
      stateVersion: last.round_state_version,
      features: new Set(),
      chain: Promise.resolve(),
    });
    this.log.warn("Artube round claimed by hand", {
      "event.category": "artube",
      "event.action":   "orphan_round_claimed",
      "artube.session_id":    sessionId,
      "artube.round_id":      orphan.roundId,
      "artube.round_version": last.round_version,
    });
    return orphan;
  }

  /** Take ownership of a round the wallet reports open, so a close for it can
   *  be sent. Without the book entry `closeComplex` refuses locally - rightly,
   *  since it would otherwise be guessing a round_version - and the session
   *  stays wedged. Here the version is not a guess: the wallet just gave it. */
  private adoptOpenRound(sessionId: string, last: ArtubeLastRound | undefined): void {
    if (last) this.lastRounds.set(sessionId, last);
    else this.lastRounds.delete(sessionId);
    if (!last || !isRoundOpen(last)) {
      this.orphans.delete(sessionId);
      return;
    }
    const orphan: ArtubeOpenRound = {
      roundId: last.round_id,
      state: unwrapState(last.round_state),
      betIndex: last.bet_index,
      priceMultiplier: last.price_multiplier,
      ...(last.round_state_version ? { mathVersion: last.round_state_version } : {}),
      ...(last.started_at ? { startedAt: last.started_at } : {}),
    };
    this.orphans.set(sessionId, orphan);
    if (!this.rounds.has(orphan.roundId)) {
      this.rounds.set(orphan.roundId, {
        sessionId,
        version: last.round_version,
        stateVersion: last.round_state_version,
        features: new Set(),
        chain: Promise.resolve(),
      });
    }
    this.log.warn("Artube reports a round this process did not open", {
      "event.category": "artube",
      "event.action":   "orphan_round_adopted",
      "artube.session_id":    sessionId,
      "artube.round_id":      orphan.roundId,
      "artube.round_version": last.round_version,
      "artube.started_at":    orphan.startedAt,
    });
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
    const receipt: RoundReceipt = {
      roundId: env.payload.round_id,
      balance: this.toMinor(env.payload.balance, req.sessionId),
    };
    if (env.payload.free_round_campaign) {
      receipt.promo = { remaining: env.payload.free_round_campaign.rounds_left };
    }
    return receipt;
  }

  // ── Complex rounds ──────────────────────────────────────────────────
  //
  // OpenRound debits the stake and returns the round id the rest of the
  // round is addressed by. Nothing else moves money until CloseRound.

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const stateVersion = req.mathVersion ?? this.defaultRoundStateVersion;
    const features = extractFeatures(req.initialState);

    // No `previous_round_id`. It chains one round to another - a bonus
    // continuing the base round that triggered it - and the platform
    // validates the chain: a round id that is not actually this session's
    // previous round is refused with InvalidRoundOperation ("Invalid rounds
    // sequence"), which fails the open and strands nothing but the player's
    // patience. Sending the last round this adapter happened to close is not
    // the same claim: simple settles do not update it, another pod may have
    // served the round in between, and either way the RGS has no concept of
    // a deliberate chain to tell us about. When open-rgs grows one, it
    // belongs in OpenComplex as an explicit field rather than inferred here.
    const payload: OpenRoundRequestPayload = {
      session_id:          req.sessionId,
      price_multiplier:    req.priceMultiplier,
      bet_index:           req.betIndex,
      ...(req.promoId  ? { free_round_campaign_id: req.promoId } : {}),
      ...(features.length > 0 ? { features: features.map((type) => ({ type })) } : {}),
      round_state_version: stateVersion,
      round_state:         packOpenState(req.initialState),
    };

    const env = await this.rpc<OpenRoundRequestPayload, OpenRoundResponsePayload>(
      "OpenRoundRequest",
      payload,
    );

    this.rounds.set(env.payload.round_id, {
      sessionId:    req.sessionId,
      version:      env.payload.round_version,
      stateVersion,
      features:     new Set(features),
      chain:        Promise.resolve(),
    });

    this.log.info("Artube complex round opened", {
      "event.category": "artube",
      "event.action":   "round_open",
      "artube.round_id":      env.payload.round_id,
      "artube.round_version": env.payload.round_version,
      "artube.bet_index":     req.betIndex,
      "artube.price_multiplier": req.priceMultiplier,
    });

    return {
      roundId: env.payload.round_id,
      balance: this.toMinor(env.payload.balance, req.sessionId),
    };
  }

  /** Audit checkpoint. Moves no money; its only job is to leave the
   *  player's action log on the wallet side, which is what a regulator
   *  reconstructs a disputed round from. */
  async updateComplex(req: UpdateComplex): Promise<void> {
    const book = this.rounds.get(req.roundId);
    if (!book) {
      throw new Error(`ArtubeAdapter: no open round ${req.roundId} to update`);
    }
    await this.onRound(book, async () => {
      const env = await this.rpc<UpdateRoundStateRequestPayload, UpdateRoundStateResponsePayload>(
        "UpdateRoundStateRequest",
        {
          session_id:          req.sessionId,
          round_id:            req.roundId,
          round_version:       book.version,
          round_state_version: book.stateVersion,
          round_state:         packOpenState(req.state),
        },
      );
      for (const f of extractFeatures(req.state)) book.features.add(f);
      book.version = env.payload.round_version;
    });
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const book = this.rounds.get(req.roundId);
    if (!book) {
      // An unknown round is not something to paper over: the money for it
      // was taken by an open this adapter never saw (another pod, a restart),
      // and guessing a round_version would either be refused or - worse -
      // land on a version that means something else.
      throw new Error(`ArtubeAdapter: no open round ${req.roundId} to close`);
    }

    // `reason` is set only when the close was triggered from outside the
    // player's own flow, which on this wire is exactly the platform's
    // autoclose. Same payload, different type, and the platform matches it
    // against the AutocloseRequestEvent it sent us.
    const isAutoclose = req.reason !== undefined;
    const type = isAutoclose ? "AutocloseRoundRequest" : "CloseRoundRequest";

    for (const f of extractFeatures(req.finalState)) book.features.add(f);
    const features = [...book.features];

    const payload: CloseRoundRequestPayload = {
      session_id:          req.sessionId,
      round_id:            req.roundId,
      win_multiplier:      req.multiplier,
      status:              closeStatus(req.finalState),
      ...(features.length > 0 ? { features: features.map((t) => ({ type: t })) } : {}),
      round_version:       book.version,
      round_state_version: req.mathVersion ?? book.stateVersion,
      round_state:         packRoundState(req.finalState, req.carry),
    };

    let env: Envelope<CloseRoundResponsePayload>;
    try {
      env = await this.onRound(book, () =>
        this.rpc<CloseRoundRequestPayload, CloseRoundResponsePayload>(type, payload));
    } catch (e) {
      // Leave the book entry in place. The round is still open wallet-side,
      // and the orchestrator keeps its own open round for a retry or an
      // autoclose; dropping our version here would make that retry fail for
      // a second, unrelated reason.
      this.log.error("Artube complex round close failed", {
        "event.category": "artube",
        "event.action":   "round_close_failed",
        "artube.round_id":   req.roundId,
        "artube.autoclose":  isAutoclose,
        "error.message":     e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    this.rounds.delete(req.roundId);
    if (this.orphans.get(req.sessionId)?.roundId === req.roundId) {
      this.orphans.delete(req.sessionId);
    }

    this.log.info("Artube complex round closed", {
      "event.category": "artube",
      "event.action":   "round_close",
      "artube.round_id":       req.roundId,
      "artube.autoclose":      isAutoclose,
      "artube.win_multiplier": req.multiplier,
      "artube.features":       features.join(",") || undefined,
      "artube.reason":         req.reason,
    });

    const receipt: RoundReceipt = {
      roundId: req.roundId,
      balance: this.toMinor(env.payload.balance, req.sessionId),
    };
    if (env.payload.free_round_campaign) {
      receipt.promo = { remaining: env.payload.free_round_campaign.rounds_left };
    }
    return receipt;
  }

  /** Run `fn` after everything already queued on this round, and keep the
   *  queue alive whatever `fn` does. */
  private onRound<T>(book: OpenRoundBook, fn: () => Promise<T>): Promise<T> {
    const next = book.chain.then(fn, fn);
    book.chain = next.catch(() => undefined);
    return next;
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
      this.log.info("Artube WS open, sending Hello", {
        "event.category": "artube",
        "event.action":   "ws_open",
        "artube.ws_url":  this.wsUrl,
      });
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      const hello = this.makeEnvelope<HelloPayload>("control", "Hello", this.helloPayload());
      hello.schema = this.schemaVersion;
      this.send(hello);
    });

    ws.on("pong", () => {
      // Refresh the liveness clock. Don't log per pong, too noisy at
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
      // 502...). This is the auth/permission-failure path, without
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
        this.log.error("Artube handshake timeout, no Welcome received", {
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
      this.log.debug("Artube reconnect already scheduled, dropping duplicate", {
        "event.category": "artube",
        "event.action":   "ws_reconnect_duplicate",
        "artube.attempt": this.reconnectAttempts,
      });
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.error("Artube max reconnect attempts reached, giving up", {
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
      // Socket isn't OPEN, nothing to ping. The close handler will
      // stopHeartbeat() when it fires; this is just defensive.
      return;
    }
    const silentMs = Date.now() - this.lastPongAt;
    if (silentMs > this.heartbeatTimeoutMs) {
      this.log.warn("Artube WS heartbeat timeout, terminating zombie connection", {
        "event.category": "artube",
        "event.action":   "ws_heartbeat_timeout",
        "artube.silent_ms":           silentMs,
        "artube.heartbeat_timeout_ms": this.heartbeatTimeoutMs,
        "artube.ws_state":            this.wsStateString(),
        "artube.pending_rpcs":        this.pending.size,
      });
      // terminate() skips the TCP/TLS close handshake, the right move
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
    // Any inbound application frame is proof the peer is alive, refresh
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
        this.log.info("Artube handshake complete, Welcome received", {
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
    // Artube's docs use both `BalanceChanged` and `BalanceChangedEvent` for
    // the same message. Match on the stem so a wallet that picks either
    // spelling is understood, instead of falling into the unknown-type
    // branch and dropping a balance update on the floor.
    switch (msg.type.replace(/Event$/, "")) {
      case "BalanceChanged": {
        const p = msg.payload as BalanceChangedPayload;
        translated = {
          type: "balanceChanged",
          sessionId: p.session_id,
          balance: this.toMinor(p.balance, p.session_id),
          reason: p.reason,
        };
        break;
      }
      case "SessionClosed": {
        const p = msg.payload as SessionClosedPayload;
        translated = { type: "sessionClosed", sessionId: p.session_id, reason: p.reason };
        break;
      }
      case "AutocloseRequest": {
        // The platform decided this round has been open long enough. Its
        // round_version is the one the AutocloseRoundRequest must carry, and
        // it is newer than ours whenever the platform wrote state itself, so
        // take it over what we last recorded.
        const p = msg.payload as AutocloseRequestEventPayload;
        const book = this.rounds.get(p.round_id);
        if (book) {
          book.version = p.round_version;
          if (p.round_state_version) book.stateVersion = p.round_state_version;
        } else {
          this.log.warn("Artube autoclose for a round this adapter has no book for", {
            "event.category": "artube",
            "event.action":   "autoclose_unknown_round",
            "artube.round_id":   p.round_id,
            "artube.session_id": p.session_id,
          });
        }
        this.log.info("Artube autoclose requested", {
          "event.category": "artube",
          "event.action":   "autoclose_requested",
          "artube.round_id":      p.round_id,
          "artube.session_id":    p.session_id,
          "artube.round_version": p.round_version,
        });
        translated = {
          type: "autocloseRequested",
          sessionId: p.session_id,
          roundId: p.round_id,
          reason: "platform-autoclose",
        };
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
      this.log.error("Artube RPC refused, not ready", {
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

  private helloPayload(): HelloPayload {
    if (this.schemaVersion < 2) return { supports: { max_schema: 1 } };
    const contracts: Record<string, { min: number; max: number }> = {};
    for (const c of DECLARED_CONTRACTS) contracts[c] = { min: 1, max: 1 };
    return { supports: { max_schema: 2, contracts, features: [] } };
  }

  /** Minor units per major unit for a session. `currency_minimal_unit` is
   *  the wallet's own statement of its precision, so it beats the adapter's
   *  configured default whenever it is present. */
  private scaleFor(gs: ArtubeGameSettings): number {
    if (!this.scaleAmounts) return 1;
    const unit = gs.currency_minimal_unit;
    if (typeof unit === "number" && unit > 0) {
      const scale = Math.round(1 / unit);
      // Guard against a malformed unit turning every amount into nonsense:
      // only accept it if it round-trips to a clean power of ten.
      if (scale >= 1 && Math.abs(1 / scale - unit) < 1e-9) return scale;
      this.log.warn("Artube currency_minimal_unit is not a clean power of ten, using configured decimals", {
        "event.category": "artube",
        "event.action":   "currency_unit_rejected",
        "artube.currency_minimal_unit": unit,
      });
    }
    return 10 ** this.currencyDecimals;
  }

  /** Artube amount -> open-rgs integer minor units. */
  private toMinor(amount: number, sessionId: string): number {
    if (!this.scaleAmounts) return amount;
    const scale = this.sessionScale.get(sessionId) ?? 10 ** this.currencyDecimals;
    return scale === 1 ? amount : Math.round(amount * scale);
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
  scale: number,
  fallbackDecimals: number,
): SessionInfo {
  // Artube states amounts in major units (150.75); open-rgs counts integer
  // minor units (15075) and refuses a fractional bet outright. `scale` is
  // the per-session conversion, derived from the wallet's own
  // currency_minimal_unit when it sends one.
  const decimals = scale > 1 ? Math.round(Math.log10(scale)) : fallbackDecimals;
  // scale === 1 is the verbatim escape hatch: pass the wallet's own numbers
  // through untouched. Rounding them "by 1" would floor a 0.25 ladder rung
  // to 0, which is a worse answer than the one the hatch exists to give.
  const conv = (n: number) => (scale === 1 ? n : Math.round(n * scale));
  const info: SessionInfo = {
    sessionId,
    currency:        p.currency,
    currencyDecimals: decimals,
    balance:         conv(p.balance),
    allowedBets:     p.game_settings.allowed_bets.map(conv),
    defaultBetIndex: p.game_settings.default_bet_index,
  };
  if (p.free_round_campaign && !p.free_round_campaign.is_complete) {
    info.promo = artubeCampaignToPromo(p.free_round_campaign, scale);
  }
  // Only a FINISHED round carries anything forward. `last_round` is whatever
  // round the session touched last, and while one is open that is the open
  // round: its `round_state` is the math's in-flight state, not a carry. The
  // RGS was being handed it anyway, so a game whose carry parser tolerates
  // the shape read a round's innards as a carry, and one that does not read
  // it as a brand-new player - silently resetting the meters of anyone whose
  // pod restarted mid-round.
  //
  // `isRoundOpen` decides which it is: the wire's own `finished_at`, plus the
  // marker this adapter writes into an in-flight round's state as a second
  // opinion that does not depend on an optional field staying present.
  //
  // No carry is the honest answer for an open round: unknown, not empty. The
  // orchestrator resumes from its own memory when it still has the session,
  // and this path is what runs when it does not.
  if (p.last_round && !isRoundOpen(p.last_round)) {
    const carry = unpackCarry(p.last_round.round_state);
    if (carry !== "") info.carry = carry;
    // `round_state_version` is the field the settle WRITES mathVersion into
    // (see settleSimple), so it is the field to read it back from.
    // `round_version` is the wallet's own round counter, an unrelated number:
    // read that instead and the version coming back is never the version that
    // was sent. The RGS compares it against the loaded math's version to decide
    // whether a stored carry is safe to thread in, so a wrong number mismatches
    // every time and discards the carry the check exists to protect.
    info.mathVersion = p.last_round.round_state_version;
  }
  return info;
}

/** Map Artube's FreeRoundCampaign wire shape into the contract's
 *  neutral PromoFreeRounds. The Artube-specific tracking fields
 *  (total_win, is_complete, valid_from) stay inside this adapter, 
 *  the platform's bonus engine owns those numbers, not the RGS. */
function artubeCampaignToPromo(c: ArtubeFreeRoundCampaign, scale: number): PromoFreeRounds {
  return {
    id:        c.campaign_id,
    bet:       scale === 1 ? c.bet : Math.round(c.bet * scale),
    remaining: c.rounds_left,
    total:     c.rounds_total,
    validTo:   c.valid_to,
  };
}

// ── round_state packing ──────────────────────────────────────────────
//
// Artube gives a round ONE opaque state slot. A complex close has two
// things to keep: the round's own final state (what an auditor replays)
// and the carry the next round starts from. Packing both under a marker
// keeps the audit record honest and still lets openSession hand the RGS
// back a carry it can use.
//
// A simple round has only one (its state IS its carry), so it is written
// unpacked - and an unmarked string read back is returned verbatim, which
// is what keeps rounds written by older builds readable.

const RGS_ENVELOPE_MARK = "$rgs";

interface RoundStateEnvelope {
  [RGS_ENVELOPE_MARK]: 1;
  /** Present and true while the round is in flight. This is how a later
   *  SessionInfo tells "the last round is still open" from "the last round
   *  finished and left a carry".
   *
   *  It has to be a marker we write, because the field that ought to answer
   *  does not: `last_round.finished_at` is documented optional and this wire
   *  omits it on finished rounds too. Reading it as the signal makes every
   *  carry look absent - the player's meters reset - while a genuinely open
   *  round stays invisible. */
  open?: true;
  state: unknown;
  carry?: unknown;
}

/** Parse if it is JSON, otherwise hand back the raw string. Stored parsed
 *  so the wallet's back office shows a round state, not an escaped blob. */
function asJsonOrString(s: string): unknown {
  if (s === "") return "";
  try { return JSON.parse(s) as unknown; } catch { return s; }
}

function fromJsonOrString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `state` alone when there is no carry to keep; both under the marker
 *  when there is. */
function packRoundState(state: string, carry?: string): string {
  if (carry === undefined) return state;
  const env: RoundStateEnvelope = {
    [RGS_ENVELOPE_MARK]: 1,
    state: asJsonOrString(state),
    carry: asJsonOrString(carry),
  };
  return JSON.stringify(env);
}

/** The state of a round that is still in flight, marked as such. */
function packOpenState(state: string): string {
  const env: RoundStateEnvelope = {
    [RGS_ENVELOPE_MARK]: 1,
    open: true,
    state: asJsonOrString(state),
  };
  return JSON.stringify(env);
}

function parseEnvelope(roundState: string): RoundStateEnvelope | undefined {
  const parsed = asJsonOrString(roundState);
  if (parsed !== null && typeof parsed === "object"
      && (parsed as Record<string, unknown>)[RGS_ENVELOPE_MARK] === 1) {
    return parsed as unknown as RoundStateEnvelope;
  }
  return undefined;
}

/** True when this round_state belongs to a round that was still in flight
 *  when it was written. */
function isOpenState(roundState: string): boolean {
  return parseEnvelope(roundState)?.open === true;
}

/**
 * Is the round the wallet just described still open?
 *
 * `finished_at` is the wire's own answer and it is the one to believe: it is
 * `null` on an open round and set on a closed one. (An earlier build here
 * refused to trust it, on the strength of one session that was ALREADY wedged
 * - whose last_round was therefore an open round, with a null finished_at.
 * That was the field working correctly, read as evidence that it did not.)
 *
 * The marker this adapter writes into an in-flight round's state is kept as a
 * second opinion. It costs nothing, it does not depend on an optional field
 * staying present, and a round is open if either says so.
 */
function isRoundOpen(last: ArtubeLastRound): boolean {
  return !last.finished_at || isOpenState(last.round_state);
}

/** The math's own state, out of whichever envelope it arrived in. */
function unwrapState(roundState: string): string {
  const env = parseEnvelope(roundState);
  return env === undefined ? roundState : fromJsonOrString(env.state);
}

/** What the next round should start from: the carry out of a packed
 *  envelope, or the whole string when it was never packed. */
function unpackCarry(roundState: string): string {
  const env = parseEnvelope(roundState);
  if (env === undefined) return roundState;   // written before the envelope existed
  if (env.open === true) return "";           // a round in flight carries nothing
  return env.carry === undefined ? "" : fromJsonOrString(env.carry);
}

/** Features the math declared, read from a reserved key in its own state.
 *  The contract has no field for them and inventing one would put an
 *  Artube concept in the neutral surface, so the math says it where it
 *  already says everything else. */
function extractFeatures(state: string): string[] {
  const parsed = asJsonOrString(unwrapState(state));
  if (parsed === null || typeof parsed !== "object") return [];
  const raw = (parsed as Record<string, unknown>)["$features"];
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const f of raw) if (typeof f === "string" && f !== "") out.add(f);
  return [...out];
}

/** "cancelled" only when the math asks for it by name. Everything else,
 *  a zero-win round included, is a round that completed. */
function closeStatus(state: string): "completed" | "cancelled" {
  const parsed = asJsonOrString(unwrapState(state));
  if (parsed !== null && typeof parsed === "object"
      && (parsed as Record<string, unknown>)["$status"] === "cancelled") {
    return "cancelled";
  }
  return "completed";
}

// Demo sessions (currency: null) served from memory. See ./demo.ts.
export { withDemoSessions, type DemoSessionsOptions } from "./demo.js";
