import { describe, expect, test } from "bun:test";
import { createLogger, type LogEntry } from "../src/index.js";

function capture(): { sink: (e: LogEntry) => void; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { sink: (e) => entries.push(e), entries };
}

describe("@open-rgs/log", () => {
  test("emits with service metadata and timestamp", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "svc", version: "1.0.0", sink });
    log.info("hello");
    expect(entries.length).toBe(1);
    const e = entries[0]!;
    expect(e["log.level"]).toBe("info");
    expect(e.message).toBe("hello");
    expect(e["service.name"]).toBe("svc");
    expect(e["service.version"]).toBe("1.0.0");
    expect(e["@timestamp"]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("drops below minLevel", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink, minLevel: "warn" });
    log.debug("a"); log.info("b"); log.warn("c"); log.error("d");
    expect(entries.length).toBe(2);
    expect(entries.map(e => e.message)).toEqual(["c", "d"]);
  });

  test("setLevel changes runtime threshold", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink, minLevel: "warn" });
    log.info("dropped");
    log.setLevel("debug");
    log.info("kept");
    expect(entries.map(e => e.message)).toEqual(["kept"]);
  });

  test("child() inherits bound fields", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink });
    const c = log.child({ "round.id": "r-1", "session.id": "s-1" });
    c.info("step");
    const e = entries[0]!;
    expect(e["round.id"]).toBe("r-1");
    expect(e["session.id"]).toBe("s-1");
  });

  test("child() per-call fields override bound fields", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink });
    const c = log.child({ tag: "outer" });
    c.info("m", { tag: "inner" });
    expect(entries[0]!.tag).toBe("inner");
  });

  test("exception decomposes Error onto error.* fields", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink });
    log.exception("boom", new Error("nope"));
    const e = entries[0]!;
    expect(e["log.level"]).toBe("error");
    expect(e["error.message"]).toBe("nope");
    expect(typeof e["error.stack_trace"]).toBe("string");
  });

  test("ring buffer retains recent entries", () => {
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink, ringBufferSize: 3 });
    for (const m of ["a", "b", "c", "d", "e"]) log.info(m);
    const recent = log.getRecent();
    expect(recent.map(e => e.message)).toEqual(["e", "d", "c"]); // newest first
    expect(entries.length).toBe(5); // sink still received all
  });

  test("getRecent filters by level", () => {
    const { sink } = capture();
    const log = createLogger({ service: "x", version: "0", sink, minLevel: "debug" });
    log.debug("a"); log.info("b"); log.warn("c"); log.error("d");
    const errs = log.getRecent("error");
    expect(errs.map(e => e.message)).toEqual(["d"]);
    const warnsUp = log.getRecent("warn");
    expect(warnsUp.map(e => e.message)).toEqual(["d", "c"]);
  });

  test("redacts configured keys recursively (case-insensitive)", () => {
    const { sink, entries } = capture();
    const log = createLogger({
      service: "x", version: "0", sink,
      redactKeys: ["password", "token"],
    });
    log.info("auth", {
      user: { name: "alice", PASSWORD: "secret" },
      headers: { Token: "abc.def" },
      okay: "yes",
    });
    const e = entries[0]!;
    const user = e.user as Record<string, unknown>;
    const headers = e.headers as Record<string, unknown>;
    expect(user["PASSWORD"]).toBe("[REDACTED]");
    expect(user["name"]).toBe("alice");
    expect(headers["Token"]).toBe("[REDACTED]");
    expect(e.okay).toBe("yes");
  });

  test("samples 1-in-N by event.action", () => {
    const { sink, entries } = capture();
    const log = createLogger({
      service: "x", version: "0", sink,
      sampleEvery: { "spin.tick": 5 },
    });
    for (let i = 0; i < 17; i++) log.info("tick", { "event.action": "spin.tick", i });
    // 1, 6, 11, 16 -> 4 entries (1-indexed counter, c % N === 1)
    expect(entries.length).toBe(4);
    expect(entries.map(e => e.i)).toEqual([0, 5, 10, 15]);
  });

  test("LOG_LEVEL env overrides default minLevel", () => {
    const prev = process.env["LOG_LEVEL"];
    process.env["LOG_LEVEL"] = "error";
    const { sink, entries } = capture();
    const log = createLogger({ service: "x", version: "0", sink });
    log.info("dropped"); log.error("kept");
    if (prev === undefined) delete process.env["LOG_LEVEL"]; else process.env["LOG_LEVEL"] = prev;
    expect(entries.map(e => e.message)).toEqual(["kept"]);
  });

  test("a broken sink never throws upstream", () => {
    const log = createLogger({
      service: "x", version: "0",
      sink: () => { throw new Error("disk full"); },
    });
    expect(() => log.info("anything")).not.toThrow();
  });
});
