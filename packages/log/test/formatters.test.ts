import { describe, expect, test } from "bun:test";
import { createLogger, formatters, type LogEntry } from "../src/index.js";

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    "@timestamp": "2026-01-02T12:34:56.789Z",
    "log.level": "info",
    message: "hello",
    "service.name": "svc",
    "service.version": "1.0.0",
    ...over,
  };
}

describe("formatters", () => {
  test("json round-trips through JSON.parse", () => {
    const out = formatters.json(entry({ extra: "yes" }));
    const back = JSON.parse(out);
    expect(back["message"]).toBe("hello");
    expect(back["extra"]).toBe("yes");
  });

  test("server-core drops service.environment + _private keys", () => {
    const out = formatters["server-core"](entry({
      "service.environment": "production",
      "user.id": "alice",
      "_internal": "leaked",
    }));
    const back = JSON.parse(out);
    expect(back["service.environment"]).toBeUndefined();
    expect(back["_internal"]).toBeUndefined();
    expect(back["user.id"]).toBe("alice");
    expect(back["message"]).toBe("hello");
  });

  test("server-core preserves stable field order (byte-shape stable)", () => {
    const out = formatters["server-core"](entry({
      "user.id": "alice",
      "service.environment": "production",
      "event.action": "spin",
    }));
    // First five keys MUST be in this order so the legacy server-core positional
    // log parsers (if any) line up.
    const keys = Object.keys(JSON.parse(out));
    expect(keys.slice(0, 5)).toEqual([
      "@timestamp", "log.level", "message", "service.name", "service.version",
    ]);
  });

  test("server-core via createLogger format option emits legacy server-core shape", () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => { lines.push(s); return true; };
    try {
      const log = createLogger({
        service: "rgs",
        version: "0.1.0",
        environment: "production",  // would be stripped
        format: "server-core",
      });
      log.info("ready", { "event.action": "startup", "round.id": "r-1" });
    } finally {
      (process.stdout.write as unknown as typeof original) = original;
    }
    const parsed = JSON.parse(lines[0]!);
    expect(parsed["service.environment"]).toBeUndefined();
    expect(parsed["event.action"]).toBe("startup");
    expect(parsed["round.id"]).toBe("r-1");
    expect(parsed["service.name"]).toBe("rgs");
  });

  test("sink that throws falls back to stderr (no silent loss)", () => {
    const stderrLines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr.write as unknown as (s: string) => boolean) = (s: string) => { stderrLines.push(s); return true; };
    try {
      const log = createLogger({
        service: "svc",
        version: "0",
        sink: () => { throw new Error("disk full"); },
      });
      expect(() => log.info("important")).not.toThrow();
    } finally {
      (process.stderr.write as unknown as typeof original) = original;
    }
    // The original message + the sink failure both surface in stderr
    expect(stderrLines.length).toBeGreaterThan(0);
    const parsed = JSON.parse(stderrLines[0]!);
    expect(parsed["event.action"]).toBe("sink_failed");
    expect(parsed["error.message"]).toBe("disk full");
    expect(parsed["original.entry"]).toBeDefined();
  });

  test("pretty starts with time + level + message", () => {
    // ANSI codes around the level; strip them for the assertion
    const out = formatters.pretty(entry()).replace(/\x1b\[[0-9;]*m/g, "");
    expect(out).toContain("12:34:56.789");
    expect(out).toContain("INFO");
    expect(out).toContain("hello");
  });

  test("logfmt emits ts/level/msg + extras", () => {
    const out = formatters.logfmt(entry({ user: "alice", "session.id": "s-1" }));
    expect(out).toContain('ts=2026-01-02T12:34:56.789Z');
    expect(out).toContain("level=info");
    expect(out).toContain("msg=hello");
    expect(out).toContain("user=alice");
    expect(out).toContain("session.id=s-1");
  });

  test("logfmt quotes values with spaces or equals", () => {
    const out = formatters.logfmt(entry({ note: "has space", weird: "a=b" }));
    expect(out).toContain('note="has space"');
    expect(out).toContain('weird="a=b"');
  });

  test("text is plain single line", () => {
    const out = formatters.text(entry());
    expect(out).toBe("2026-01-02T12:34:56.789Z [INFO] hello");
  });

  test("createLogger({ format: 'logfmt' }) routes through formatter", () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => { lines.push(s); return true; };
    try {
      const log = createLogger({
        service: "svc", version: "1.0.0",
        format: "logfmt",
      });
      log.info("hi", { x: 1 });
    } finally {
      (process.stdout.write as unknown as typeof original) = original;
    }
    expect(lines[0]).toMatch(/level=info msg=hi/);
    expect(lines[0]).toContain("x=1");
  });

  test("custom formatter function is called for info -> stdout", () => {
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => { lines.push(s); return true; };
    try {
      const log = createLogger({
        service: "svc", version: "1.0.0",
        format: (e) => `>>> ${e["log.level"]} :: ${e.message}`,
      });
      log.info("hi");
    } finally {
      (process.stdout.write as unknown as typeof original) = original;
    }
    expect(lines[0]).toBe(">>> info :: hi\n");
  });

  test("LOG_FORMAT env picks formatter when format opt omitted", () => {
    const prev = process.env["LOG_FORMAT"];
    process.env["LOG_FORMAT"] = "text";
    const lines: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown as (s: string) => boolean) = (s: string) => { lines.push(s); return true; };
    try {
      const log = createLogger({ service: "svc", version: "1.0.0" });
      log.info("env-driven");
    } finally {
      (process.stdout.write as unknown as typeof original) = original;
      if (prev === undefined) delete process.env["LOG_FORMAT"];
      else process.env["LOG_FORMAT"] = prev;
    }
    expect(lines[0]).toContain("[INFO]");
    expect(lines[0]).toContain("env-driven");
  });

  test("explicit sink overrides format", () => {
    const captured: LogEntry[] = [];
    const log = createLogger({
      service: "svc", version: "1.0.0",
      format: "pretty",
      sink: (e) => captured.push(e),
    });
    log.info("test");
    expect(captured.length).toBe(1);
    expect(captured[0]!.message).toBe("test");
  });
});
