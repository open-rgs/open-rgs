// @open-rgs/simulator public surface.

export { simulate, type SimulateOptions } from "./simulate.js";
export { mergeReports } from "./merge.js";
export { simulateWasmBatch, reportFromAggregate, type WasmBatchReport, type WasmBatchOptions, type BatchAggregate } from "./wasm-batch.js";
export { simulateNativeBatch, type NativeBatchOptions } from "./native-batch.js";
export { mdReport, mdReportSet, type SimulationReport, type DistributionStats } from "./report.js";
export { htmlReportSet, type HtmlReportOptions } from "./html.js";
export { computeDeviations, narrate, type TargetDeviation, type DeviationStatus } from "./deviation.js";
export { mulberry32 } from "./rng.js";
