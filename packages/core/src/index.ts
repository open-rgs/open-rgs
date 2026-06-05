// @open-rgs/core public surface

export { createServer, type ServerConfig, type ServerHandle } from "./server.js";
export { createOrchestrator, defaultIdempotencyKey } from "./orchestrator.js";
export { settleAmount, roundHalfEven } from "./money.js";
export { deriveIdempotencyKey, uuidV4 } from "./idempotency.js";
export {
  createAuditLog, verifyChain, memoryAuditSink, jsonlStdoutAuditSink, AUDIT_GENESIS_HASH,
  type AuditLog, type AuditSink, type AuditEvent, type AuditInput, type RoundOutcomeStatus,
} from "./audit-log.js";
export { binaryTransport } from "./transport-binary.js";
export { loadLuaMath, cryptoRng, type LoadLuaMathOptions } from "./lua-math.js";
export { loadWasmMath, type LoadWasmMathOptions } from "./wasm-math.js";
export { createMathPool, type MathPool, type MathPoolOptions } from "./math-pool.js";
export { startAdmin } from "./admin.js";
export { log } from "./log.js";
export { Registry, DEFAULT_BUCKETS, type Counter, type Gauge, type Histogram } from "./metrics.js";
export { createRgsMetrics, type RgsMetrics } from "./metrics-rgs.js";
export * as session from "./session.js";
export * as promo from "./promo.js";
