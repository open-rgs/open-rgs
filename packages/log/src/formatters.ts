// Stdout formatters. The default sink uses one of these to turn a
// LogEntry into a string. Apps can pick a builtin or pass their own.
//
// Builtins:
//   "json"        — ECS-aligned JSON (default; what most dashboards want)
//   "server-core" — legacy server-core / server-core byte-shape: same as json but DROPS
//                   service.environment + private "_*" keys, with a stable
//                   field order so the legacy server-core downstream log tooling parses
//                   ours unchanged
//   "pretty"      — human-readable single-line: 12:34:56 INFO msg k=v
//   "logfmt"      — key=value pairs, Heroku/Datadog ingestable
//   "text"        — single-line "TIMESTAMP [LEVEL] message" — no fields
//
// Custom: pass a function (entry: LogEntry) => string.

import type { LogEntry, LogLevel } from "./types.js";

export type FormatterName = "json" | "server-core" | "pretty" | "logfmt" | "text";

export type Formatter = (entry: LogEntry) => string;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "\x1b[2;37m",   // dim white
  info:  "\x1b[36m",     // cyan
  warn:  "\x1b[33m",     // yellow
  error: "\x1b[31m",     // red
  fatal: "\x1b[1;31m",   // bold red
};
const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";

/** Standard fields we render explicitly in pretty/text/logfmt; everything
 *  else goes into the trailing fields blob. */
const RESERVED = new Set<string>([
  "@timestamp", "log.level", "message",
  "service.name", "service.version", "service.environment",
]);

export const formatters: Record<FormatterName, Formatter> = {
  json(entry) {
    return JSON.stringify(entry);
  },

  /** legacy server-core / server-core byte-shape match. Strips service.environment
   *  (server-core doesn't emit it) and any "_*" private fields. Fixes
   *  field order: @timestamp, log.level, message, service.name,
   *  service.version, then everything else in insertion order.
   *
   *  Use this when piping into a downstream log tool that was built
   *  against the legacy server-core logger output — fluent-bit pipelines, custom
   *  parsers, dashboards keyed on field positions, etc. */
  "server-core"(entry) {
    const out: Record<string, unknown> = {
      "@timestamp":      entry["@timestamp"],
      "log.level":       entry["log.level"],
      "message":         entry.message,
      "service.name":    entry["service.name"],
      "service.version": entry["service.version"],
    };
    for (const k of Object.keys(entry)) {
      if (k in out) continue;
      if (k === "service.environment") continue;  // legacy server-core doesn't emit this
      if (k.startsWith("_")) continue;            // private/internal markers
      out[k] = entry[k];
    }
    return JSON.stringify(out);
  },

  pretty(entry) {
    const ts = entry["@timestamp"].slice(11, 23); // HH:MM:SS.mmm
    const lvl = entry["log.level"];
    const color = LEVEL_COLOR[lvl] ?? "";
    const tag = `${color}${lvl.toUpperCase().padEnd(5)}${RESET}`;
    const fields = extras(entry);
    const fieldStr = fields.length === 0 ? "" : ` ${DIM}${renderLogfmtFields(fields)}${RESET}`;
    return `${DIM}${ts}${RESET} ${tag} ${entry.message}${fieldStr}`;
  },

  logfmt(entry) {
    const head: Array<[string, unknown]> = [
      ["ts",    entry["@timestamp"]],
      ["level", entry["log.level"]],
      ["msg",   entry.message],
    ];
    return renderLogfmtFields([...head, ...extras(entry)]);
  },

  text(entry) {
    return `${entry["@timestamp"]} [${entry["log.level"].toUpperCase()}] ${entry.message}`;
  },
};

/** Build a stdout/stderr sink from a formatter (builtin name or custom fn). */
export function makeStdoutSink(formatter: FormatterName | Formatter): (entry: LogEntry) => void {
  const fmt: Formatter = typeof formatter === "function"
    ? formatter
    : (formatters[formatter] ?? formatters.json);
  return (entry) => {
    const line = fmt(entry) + "\n";
    const out = entry["log.level"] === "error" || entry["log.level"] === "fatal"
      ? process.stderr
      : process.stdout;
    out.write(line);
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function extras(entry: LogEntry): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  for (const k of Object.keys(entry)) {
    if (RESERVED.has(k)) continue;
    out.push([k, entry[k]]);
  }
  return out;
}

function renderLogfmtFields(fields: Array<[string, unknown]>): string {
  return fields.map(([k, v]) => `${k}=${logfmtValue(v)}`).join(" ");
}

function logfmtValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") {
    if (/[\s"=]/.test(v)) return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects/arrays — render as compact JSON. Logfmt purists frown; we're pragmatic.
  return `"${JSON.stringify(v).replace(/"/g, '\\"')}"`;
}
