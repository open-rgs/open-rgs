# @open-rgs/log

Structured JSON logger for open-rgs. ECS-aligned fields, in-process ring
buffer, child loggers, redaction, sampling. Zero deps.

Built for production RGS workloads: log everything important, never
crash on a bad sink, redact PII at the boundary, scale to thousands of
RPS with sampling.

## Use

```ts
import { createLogger } from "@open-rgs/log";

const log = createLogger({
  service: "rgs-hello-spin",
  version: "0.1.0",
  environment: process.env.NODE_ENV,
  minLevel: "info",
  redactKeys: ["password", "token", "session_id"],
  ringBufferSize: 2000,
  sampleEvery: { "spin.tick": 100 },  // log 1 of every 100 ticks
});

log.info("server starting", { "event.category": "process", "event.action": "startup" });

// Per-request scope
const reqLog = log.child({ "request.id": "abc123", "session.id": "s-1" });
reqLog.warn("slow wallet call", { "event.action": "wallet.slow", "duration_ms": 850 });

// Exceptions
try { /* ... */ }
catch (e) { log.exception("spin failed", e, { "event.action": "spin" }); }

// Pull recent entries (newest first)  - for an admin /logs endpoint
const recent = log.getRecent("warn", 100);
```

## ECS-aligned output

```json
{
  "@timestamp": "2026-05-23T12:00:00.000Z",
  "log.level": "warn",
  "message": "slow wallet call",
  "service.name": "rgs-hello-spin",
  "service.version": "0.1.0",
  "service.environment": "production",
  "event.action": "wallet.slow",
  "duration_ms": 850,
  "request.id": "abc123",
  "session.id": "[REDACTED]"
}
```

## Features

| Feature           | Why                                                                |
|-------------------|--------------------------------------------------------------------|
| ECS field names   | Drops into Elastic / Datadog / Grafana Loki dashboards unchanged   |
| Ring buffer       | Admin endpoint can return last N entries without external storage  |
| Child loggers     | Per-request / per-session context without repeating field names    |
| PII redaction     | Case-insensitive, recursive, never mutates caller's objects        |
| Sampling          | Keyed by `event.action`; drops to 1-in-N for high-volume entries   |
| Pluggable sink    | Default is stdout JSON; swap for syslog / OTEL collector / file    |
| Sink-safe         | A throwing sink never crashes the caller                           |
| Runtime levels    | `log.setLevel("debug")` from an admin handler when triaging        |
| `LOG_LEVEL` env   | Standard 12-factor; overrides the default minLevel                 |

## Test

```bash
bun install
bun test    # 11 cases
```
