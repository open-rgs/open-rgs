// Standard RGS metrics built on top of the generic Registry. One
// shared registry per server, owned by createServer and surfaced via
// the admin /metrics endpoint.
//
// Conventions:
//   - units in the metric name (e.g. _seconds, _total)
//   - low-cardinality labels only (kind, mode, method, reason). NEVER
//     per-session-id or per-round-id — Prom hates high cardinality.

import { Registry, type Counter, type Gauge, type Histogram } from "./metrics.js";

export interface RgsMetrics {
  registry: Registry;
  /** Settled simple-round or close of a complex-round. */
  roundTotal: Counter;          // {kind, mode, type}
  /** Wall-clock duration of a round, end-to-end (request → response). */
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
  };
}
