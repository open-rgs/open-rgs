// Public types for @open-rgs/log.

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  /** ISO-8601 timestamp at emit time. */
  "@timestamp": string;
  "log.level": LogLevel;
  message: string;
  /** Service identity. Set by createLogger; carried on every entry. */
  "service.name"?: string;
  "service.version"?: string;
  "service.environment"?: string;
  /** ECS-style categorisation. */
  "event.category"?: string;
  "event.action"?: string;
  /** Exception decomposition when log.exception was called. */
  "error.message"?: string;
  "error.stack_trace"?: string;
  /** Anything else the caller attached. */
  [k: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  fatal(message: string, fields?: Record<string, unknown>): void;
  /** Decompose an Error onto error.message + error.stack_trace and log as error. */
  exception(message: string, err: unknown, fields?: Record<string, unknown>): void;
  /** Return a Logger that auto-merges `bound` into every emitted entry. */
  child(bound: Record<string, unknown>): Logger;
  /** Pull recent entries from the ring buffer (newest first). */
  getRecent(level?: LogLevel, limit?: number): LogEntry[];
  /** Mutate the minimum level at runtime. Useful for ops admin endpoints. */
  setLevel(level: LogLevel): void;
  /** Current minimum level. */
  getLevel(): LogLevel;
}

export interface LoggerOptions {
  /** Service name; surfaced as service.name. */
  service: string;
  /** Service semver; surfaced as service.version. */
  version: string;
  /** dev / staging / production; surfaced as service.environment. */
  environment?: string;
  /** Minimum level emitted. Anything below is dropped silently. Default "info" (or "debug" when env LOG_LEVEL=debug). */
  minLevel?: LogLevel;
  /** Ring buffer capacity. Default 2000. Set to 0 to disable. */
  ringBufferSize?: number;
  /** Field keys to redact recursively (replaced with "[REDACTED]"). */
  redactKeys?: readonly string[];
  /** Sample N-th matching entry (1-in-N). Keyed by event.action; default is "always log". */
  sampleEvery?: Record<string, number>;
  /** Override stdout/stderr emission. Called with the assembled LogEntry.
   *  Mutually exclusive with `format`; pass either. */
  sink?: (entry: LogEntry) => void;
  /** Builtin formatter ("json" | "pretty" | "logfmt" | "text") or a custom
   *  (entry) => string function. When set without `sink`, builds a stdout
   *  sink that renders each entry through this formatter.
   *
   *   "json"    - ECS-aligned single-line JSON (default; what dashboards want)
   *   "pretty"  - colour-tinted human-readable: "12:34:56 INFO message k=v"
   *   "logfmt"  - Heroku/Datadog key=value pairs
   *   "text"    - plain "TIMESTAMP [LEVEL] message" (no fields)
   *
   *  Pass a function for full control. */
  format?: import("./formatters.js").FormatterName | import("./formatters.js").Formatter;
}
