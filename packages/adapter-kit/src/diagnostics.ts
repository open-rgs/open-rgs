// Diagnostics builder. Every adapter exposes `diagnostics` for the
// /healthz endpoint; this normalises the standard fields so dashboards
// and humans see consistent shapes across providers.

export interface DiagnosticsOptions {
  /** Adapter identity (e.g. "your-provider", "pragmatic", "everymatrix"). */
  adapter: string;
  /** Adapter version (semver). */
  version: string;
  /** Game id stamped on outbound calls. */
  gameId?: string;
  /** Upstream endpoint URL (host:port or full URL). PII-free. */
  endpoint?: string;
}

export interface DiagnosticsState {
  connected: boolean;
  reconnectAttempt: number;
  rpcsInFlight: number;
  rpcsSettled: number;
  rpcsFailed: number;
  eventsReceived: number;
  lastConnectAt: number;
  lastDisconnectAt: number;
  /** ms since last successful heartbeat / pong / ping. */
  lastHeartbeatAt: number;
  /** Free-form per-adapter additions. */
  extras: Record<string, unknown>;
}

export interface DiagnosticsHandle extends DiagnosticsState {
  snapshot(): Record<string, unknown>;
  noteConnect(): void;
  noteDisconnect(): void;
  noteHeartbeat(): void;
  noteRpcStart(): void;
  noteRpcDone(succeeded: boolean): void;
  noteEvent(): void;
  noteReconnectAttempt(): void;
  setExtra(key: string, value: unknown): void;
}

export function createDiagnostics(opts: DiagnosticsOptions): DiagnosticsHandle {
  const state: DiagnosticsState = {
    connected: false,
    reconnectAttempt: 0,
    rpcsInFlight: 0,
    rpcsSettled: 0,
    rpcsFailed: 0,
    eventsReceived: 0,
    lastConnectAt: 0,
    lastDisconnectAt: 0,
    lastHeartbeatAt: 0,
    extras: {},
  };

  return {
    ...state,
    get connected() { return state.connected; },
    get reconnectAttempt() { return state.reconnectAttempt; },
    get rpcsInFlight() { return state.rpcsInFlight; },
    get rpcsSettled() { return state.rpcsSettled; },
    get rpcsFailed() { return state.rpcsFailed; },
    get eventsReceived() { return state.eventsReceived; },
    get lastConnectAt() { return state.lastConnectAt; },
    get lastDisconnectAt() { return state.lastDisconnectAt; },
    get lastHeartbeatAt() { return state.lastHeartbeatAt; },
    get extras() { return state.extras; },

    snapshot(): Record<string, unknown> {
      return {
        adapter: opts.adapter,
        version: opts.version,
        ...(opts.gameId !== undefined ? { gameId: opts.gameId } : {}),
        ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
        connected: state.connected,
        reconnect_attempt: state.reconnectAttempt,
        rpcs_in_flight: state.rpcsInFlight,
        rpcs_settled: state.rpcsSettled,
        rpcs_failed: state.rpcsFailed,
        events_received: state.eventsReceived,
        last_connect_at: state.lastConnectAt,
        last_disconnect_at: state.lastDisconnectAt,
        last_heartbeat_at: state.lastHeartbeatAt,
        ...state.extras,
      };
    },

    noteConnect()           { state.connected = true; state.reconnectAttempt = 0; state.lastConnectAt = Date.now(); },
    noteDisconnect()        { state.connected = false; state.lastDisconnectAt = Date.now(); },
    noteHeartbeat()         { state.lastHeartbeatAt = Date.now(); },
    noteRpcStart()          { state.rpcsInFlight += 1; },
    noteRpcDone(ok)         { state.rpcsInFlight = Math.max(0, state.rpcsInFlight - 1); if (ok) state.rpcsSettled += 1; else state.rpcsFailed += 1; },
    noteEvent()             { state.eventsReceived += 1; },
    noteReconnectAttempt()  { state.reconnectAttempt += 1; },
    setExtra(k, v)          { state.extras[k] = v; },
  };
}
