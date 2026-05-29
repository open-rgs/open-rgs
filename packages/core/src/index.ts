// @open-rgs/core public surface

export { createServer, type ServerConfig, type ServerHandle } from "./server.js";
export { createOrchestrator, defaultIdempotencyKey } from "./orchestrator.js";
export { settleAmount, roundHalfEven } from "./money.js";
export { deriveIdempotencyKey, uuidV4 } from "./idempotency.js";
export { binaryTransport } from "./transport-binary.js";
export { loadLuaMath, type LoadLuaMathOptions } from "./lua-math.js";
export { startAdmin } from "./admin.js";
export { log } from "./log.js";
export { Registry, DEFAULT_BUCKETS, type Counter, type Gauge, type Histogram } from "./metrics.js";
export { createRgsMetrics, type RgsMetrics } from "./metrics-rgs.js";
export * as session from "./session.js";
export * as promo from "./promo.js";
