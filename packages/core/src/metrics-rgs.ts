// Standard RGS metrics built on top of the generic Registry. One
// shared registry per server, owned by createServer and surfaced via
// the admin /metrics endpoint.
//
// Conventions:
//   - units in the metric name (e.g. _seconds, _total)
//   - low-cardinality labels only (kind, mode, method, reason). NEVER
//     per-session-id or per-round-id  - Prom hates high cardinality.

import { Registry, type Counter, type Gauge, type Histogram } from "./metrics.js";

export interface RgsMetrics {
  registry: Registry;
  /** Settled simple-round or close of a complex-round. */
  roundTotal: Counter;          // {kind, mode, type}
  /** Wall-clock duration of a round, end-to-end (request -> response). */
  roundDuration: Histogram;     // {kind, mode}
  /** Per-method platform-adapter RPC duration. */
  platformDuration: Histogram;  // {method}
  /** Per-method platform-adapter error count, labelled by reason. */
  platformErrors: Counter;      // {method, reason}
  /** Currently active sessions (after INIT, before close). */
  sessionsActive: Gauge;
  /** Open WebSocket connections. */
  wsConnections: Gauge;
  /** Lua math execution duration, per call (play / open / step / close). */
  mathDuration: Histogram;      // {kind, mode, phase}
  /** Constant 1 carrying this instance's identity as labels  - the
   *  node_exporter build_info pattern. Dashboards join on instance_id;
   *  a fresh series appearing = an instance (re)started. */
  buildInfo: Gauge;             // {instance_id, game, core_version, game_version}
  /** 1 while the platform adapter reports healthy, else 0. The
   *  "is the wallet there at all" SLA gauge. */
  platformConnected: Gauge;
  /** Connection state transitions  - flap visibility. */
  platformTransitions: Counter; // {direction: up|down}
  /** Unix seconds of the last SUCCESSFUL platform RPC. Alert on
   *  `time() - rgs_platform_last_ok_timestamp_seconds` to catch a wallet
   *  that is "connected" but not answering. */
  platformLastOk: Gauge;
  /** Stakes, in the currency's minor unit. funding="real" counts the actual
   *  debit (the effective cost incl. price/stake multipliers - fractional
   *  ante costs allowed); funding="promo" counts the NOTIONAL bet of a
   *  platform-funded free round (no player debit). Monotonic in-process
   *  counters: GGR and RTP are DERIVED at query time, which is the only way
   *  ratios aggregate correctly across a fleet -
   *    GGR  = sum(rgs_bets_minor_total{funding="real"}) - sum(rgs_wins_minor_total)
   *    RTP  = sum(increase(rgs_wins_minor_total[w])) / sum(increase(rgs_bets_minor_total[w])) */
  betsMinor: Counter;           // {currency, mode, funding}
  /** Wins credited, in the currency's minor unit, labelled by the funding
   *  of the round that produced them. */
  winsMinor: Counter;           // {currency, mode, funding}
  /** Declared/theoretical RTP per mode - the target line dashboards draw
   *  against live RTP. */
  declaredRtp: Gauge;           // {mode}
  /** Concurrency-policy interventions at INIT: an older connection kicked
   *  ("kick-old") or a newer one refused ("reject-new"). A spike means
   *  players are multi-windowing - or something is replaying tokens. */
  sessionConcurrency: Counter;  // {action: kick-old|reject-new}
}

export function createRgsMetrics(): RgsMetrics {
  const registry = new Registry();
  return {
    registry,
    roundTotal: registry.counter(
      "rgs_round_total",
      "Rounds settled, by kind / mode / outcome type.",
      ["kind", "mode", "type"],
    ),
    roundDuration: registry.histogram(
      "rgs_round_duration_seconds",
      "End-to-end round duration.",
      undefined,
      ["kind", "mode"],
    ),
    platformDuration: registry.histogram(
      "rgs_platform_call_duration_seconds",
      "Platform-adapter RPC duration.",
      undefined,
      ["method"],
    ),
    platformErrors: registry.counter(
      "rgs_platform_call_errors_total",
      "Platform-adapter RPC errors, by method and reason.",
      ["method", "reason"],
    ),
    sessionsActive: registry.gauge(
      "rgs_sessions_active",
      "Currently active sessions.",
    ),
    wsConnections: registry.gauge(
      "rgs_ws_connections_active",
      "Currently open WebSocket connections.",
    ),
    mathDuration: registry.histogram(
      "rgs_math_execution_duration_seconds",
      "Lua math execution duration, per call phase.",
      undefined,
      ["kind", "mode", "phase"],
    ),
    buildInfo: registry.gauge(
      "rgs_build_info",
      "Constant 1; labels carry instance identity (instance_id, game, versions).",
      ["instance_id", "game", "core_version", "game_version"],
    ),
    platformConnected: registry.gauge(
      "rgs_platform_connected",
      "1 while the platform adapter reports healthy, else 0.",
    ),
    platformTransitions: registry.counter(
      "rgs_platform_connection_transitions_total",
      "Platform connection state transitions, by direction.",
      ["direction"],
    ),
    platformLastOk: registry.gauge(
      "rgs_platform_last_ok_timestamp_seconds",
      "Unix time of the last successful platform RPC.",
    ),
    betsMinor: registry.counter(
      "rgs_bets_minor_total",
      "Stakes in minor units. funding=real is the actual debit; funding=promo the notional free-round bet.",
      ["currency", "mode", "funding"],
    ),
    winsMinor: registry.counter(
      "rgs_wins_minor_total",
      "Wins credited in minor units, by the round's funding.",
      ["currency", "mode", "funding"],
    ),
    declaredRtp: registry.gauge(
      "rgs_declared_rtp",
      "Declared/theoretical RTP per mode.",
      ["mode"],
    ),
    sessionConcurrency: registry.counter(
      "rgs_session_concurrency_actions_total",
      "Concurrency-policy interventions at INIT (kick-old / reject-new).",
      ["action"],
    ),
  };
}
