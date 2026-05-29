// createLogger  - the workhorse factory. The returned Logger is the
// public surface; everything else here is an implementation detail.

import type { LogEntry, LogLevel, Logger, LoggerOptions } from "./types.js";
import { buildRedactSet, redactDeep, scrubString } from "./redact.js";
import { makeStdoutSink, formatters } from "./formatters.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3, fatal: 4,
};

interface InternalState {
  service: string;
  version: string;
  environment?: string;
  minLevel: LogLevel;
  ring: LogEntry[];
  ringSize: number;
  redact: ReadonlySet<string>;
  sampleEvery: Record<string, number>;
  sampleCounters: Record<string, number>;
  sink: (e: LogEntry) => void;
}

const defaultSink = makeStdoutSink("json");

function envFormat(): import("./formatters.js").FormatterName | undefined {
  const v = process.env["LOG_FORMAT"];
  if (v === "json" || v === "server-core" || v === "pretty" || v === "logfmt" || v === "text") return v;
  return undefined;
}

function envLevel(): LogLevel | undefined {
  const v = process.env["LOG_LEVEL"];
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "fatal") return v;
  return undefined;
}

/** Build a Logger. Multiple loggers can coexist (different services /
 *  components)  - they don't share state. */
export function createLogger(opts: LoggerOptions): Logger {
  const resolvedSink = opts.sink
    ?? (opts.format ? makeStdoutSink(opts.format) : undefined)
    ?? (envFormat() ? makeStdoutSink(envFormat()!) : undefined)
    ?? defaultSink;

  const state: InternalState = {
    service: opts.service,
    version: opts.version,
    ...(opts.environment !== undefined ? { environment: opts.environment } : {}),
    minLevel: opts.minLevel ?? envLevel() ?? "info",
    ring: [],
    ringSize: opts.ringBufferSize ?? 2000,
    redact: buildRedactSet(opts.redactKeys),
    sampleEvery: { ...(opts.sampleEvery ?? {}) },
    sampleCounters: {},
    sink: resolvedSink,
  };

  return buildLogger(state, {});
}

// Re-export formatters so callers don't need a second import.
export { formatters, makeStdoutSink };

function buildLogger(state: InternalState, bound: Record<string, unknown>): Logger {
  function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[state.minLevel]) return;

    const combined: Record<string, unknown> = { ...bound };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) combined[k] = v;
      }
    }

    // Sampling: keyed by event.action. The N-th matching entry passes.
    const action = combined["event.action"];
    if (typeof action === "string" && state.sampleEvery[action]) {
      const every = state.sampleEvery[action]!;
      const c = (state.sampleCounters[action] ?? 0) + 1;
      state.sampleCounters[action] = c;
      if (c % every !== 1) return;
    }

    // Always redact: even with no custom keys the default credential set +
    // value scrubbing apply (the old `size > 0` gate skipped redaction
    // entirely when no keys were configured  - i.e. by default).
    const redacted = redactDeep(combined, state.redact) as Record<string, unknown>;

    const entry: LogEntry = {
      "@timestamp": new Date().toISOString(),
      "log.level": level,
      message: scrubString(message),
      "service.name": state.service,
      "service.version": state.version,
      ...(state.environment !== undefined ? { "service.environment": state.environment } : {}),
      ...redacted,
    };

    if (state.ringSize > 0) {
      if (state.ring.length >= state.ringSize) state.ring.shift();
      state.ring.push(entry);
    }
    try {
      state.sink(entry);
    } catch (sinkErr) {
      // The configured sink threw. We do NOT want this to crash the
      // app (a broken downstream sink shouldn't take production down)
      // but we ALSO refuse to fail silent. Fall back to a direct
      // stderr write of both the original entry AND the sink error
      // so something is always visible in container logs.
      try {
        const fallback = {
          "@timestamp": entry["@timestamp"],
          "log.level":  "error" as const,
          "message":    "logger sink threw  - falling back to stderr",
          "service.name":    entry["service.name"] ?? "unknown",
          "service.version": entry["service.version"] ?? "0.0.0",
          "event.category":  "logger",
          "event.action":    "sink_failed",
          "error.message":   sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
          "original.entry":  entry,
        };
        process.stderr.write(JSON.stringify(fallback) + "\n");
      } catch {
        // process.stderr.write threw too  - at this point the runtime
        // is so broken there's nothing left to do. We give up rather
        // than crash the app; the absent log line will be noticed by
        // the gap in healthcheck pings.
      }
    }
  }

  const log: Logger = {
    debug(m, f) { emit("debug", m, f); },
    info(m, f)  { emit("info",  m, f); },
    warn(m, f)  { emit("warn",  m, f); },
    error(m, f) { emit("error", m, f); },
    fatal(m, f) { emit("fatal", m, f); },
    exception(m, e, f) {
      const err = e instanceof Error ? e : new Error(String(e));
      emit("error", m, { ...f, "error.message": err.message, "error.stack_trace": err.stack });
    },
    child(bind) {
      return buildLogger(state, { ...bound, ...bind });
    },
    getRecent(level?, limit = 500) {
      const min = level ? LEVEL_ORDER[level] : 0;
      const out: LogEntry[] = [];
      for (let i = state.ring.length - 1; i >= 0 && out.length < limit; i--) {
        const e = state.ring[i]!;
        if (LEVEL_ORDER[e["log.level"]] >= min) out.push(e);
      }
      return out;
    },
    setLevel(level) { state.minLevel = level; },
    getLevel()      { return state.minLevel; },
  };
  return log;
}
