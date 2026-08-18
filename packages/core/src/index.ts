// @open-rgs/core public surface

export { createServer, type ServerConfig, type ServerHandle } from "./server.js";
export {
  createOrchestrator, defaultIdempotencyKey, UNFINISHED_ROUND_MESSAGE,
  // The cap rule itself, exported so anything that must agree with the engine
  // about what a round pays - the simulator's parity test, an operator's
  // reconciliation script - can call it rather than reimplement it.
  applyMaxWinCap, applyMaxWinCapClose,
} from "./orchestrator.js";
export { settleAmount, roundHalfEven } from "./money.js";
export { deriveIdempotencyKey, uuidV4 } from "./idempotency.js";
export { createRequestCache, type RequestCache, type RequestCacheOptions } from "./request-cache.js";
export { OPAQUE_ERROR_CODES, isOpaque, clientMessage } from "./error-policy.js";
export { validateRequest, type WireCall } from "./wire-validate.js";
export {
  createAuditLog, verifyChain, memoryAuditSink, jsonlStdoutAuditSink, AUDIT_GENESIS_HASH,
  type AuditLog, type AuditLogOptions, type AuditSink, type AuditEvent, type AuditInput, type RoundOutcomeStatus,
} from "./audit-log.js";
export { binaryTransport } from "./transport-binary.js";
export { restTransport, type RestTransportOptions } from "./transport-rest.js";
export {
  withDeferredClose, isAwaitingEndRound, END_ROUND_ACTION,
  type DeferredCloseOptions,
} from "./deferred-close.js";
export { cryptoRng, resolveRng } from "./rng.js";
export { loadWasmMath, type LoadWasmMathOptions } from "./wasm-math.js";
export {
  loadTsMath, assertPure, collectMathSources, hashMathSources,
  type LoadTsMathOptions, type Replayable,
} from "./ts-math.js";
export { createMathPool, type MathPool, type MathPoolOptions } from "./math-pool.js";
export { startAdmin } from "./admin.js";
export { log } from "./log.js";
export { Registry, DEFAULT_BUCKETS, type Counter, type Gauge, type Histogram } from "./metrics.js";
export { createRgsMetrics, type RgsMetrics } from "./metrics-rgs.js";
export * as session from "./session.js";
export * as promo from "./promo.js";
