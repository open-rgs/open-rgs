import { describe, expect, test } from "bun:test";
import { Registry, DEFAULT_BUCKETS } from "../src/metrics.js";

describe("@open-rgs/core metrics", () => {
  test("counter without labels", () => {
    const r = new Registry();
    const c = r.counter("hits", "test hits");
    c.inc();
    c.inc(4);
    const text = r.expose();
    expect(text).toContain("# HELP hits test hits");
    expect(text).toContain("# TYPE hits counter");
    expect(text).toContain("hits 5");
  });

  test("counter with labels groups by label combo", () => {
    const r = new Registry();
    const c = r.counter("rounds", "rounds settled", ["kind", "mode"]);
    c.inc(1, { kind: "simple", mode: "default" });
    c.inc(2, { kind: "simple", mode: "default" });
    c.inc(1, { kind: "complex", mode: "gamble" });
    const text = r.expose();
    expect(text).toContain('rounds{kind="simple",mode="default"} 3');
    expect(text).toContain('rounds{kind="complex",mode="gamble"} 1');
  });

  test("gauge set / inc / dec", () => {
    const r = new Registry();
    const g = r.gauge("active", "active things");
    g.set(10);
    g.inc(5);
    g.dec(3);
    expect(r.expose()).toContain("active 12");
  });

  test("histogram emits cumulative buckets + sum + count", () => {
    const r = new Registry();
    const h = r.histogram("latency", "latency", [0.1, 0.5, 1.0]);
    h.observe(0.05); h.observe(0.3); h.observe(0.7); h.observe(2.0);
    const text = r.expose();
    expect(text).toContain('latency_bucket{le="0.1"} 1');   // 0.05
    expect(text).toContain('latency_bucket{le="0.5"} 2');   // +0.3
    expect(text).toContain('latency_bucket{le="1"} 3');     // +0.7  (le=1 stringifies as "1")
    expect(text).toContain('latency_bucket{le="+Inf"} 4');  // +2.0
    expect(text).toContain('latency_sum');
    expect(text).toContain('latency_count 4');
  });

  test("histogram.time observes wall-clock seconds", async () => {
    const r = new Registry();
    const h = r.histogram("op", "op latency", [0.005, 0.05, 0.5]);
    await h.time(() => new Promise<void>(res => setTimeout(res, 12)));
    const text = r.expose();
    // 12ms sample should land somewhere; total count == 1
    expect(text).toContain("op_count 1");
  });

  test("histogram with labels", () => {
    const r = new Registry();
    const h = r.histogram("call", "call latency", [0.1], ["method"]);
    h.observe(0.05, { method: "openSession" });
    h.observe(0.5, { method: "settleSimple" });
    const text = r.expose();
    expect(text).toContain('call_bucket{method="openSession",le="0.1"} 1');
    expect(text).toContain('call_bucket{method="settleSimple",le="0.1"} 0');
    expect(text).toContain('call_count{method="openSession"} 1');
    expect(text).toContain('call_count{method="settleSimple"} 1');
  });

  test("empty counter still emits a zero line", () => {
    const r = new Registry();
    r.counter("idle", "never inc'd");
    expect(r.expose()).toContain("idle 0");
  });

  test("DEFAULT_BUCKETS spans sub-ms to ~10s", () => {
    expect(DEFAULT_BUCKETS[0]).toBe(0.001);
    expect(DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1]).toBe(10);
  });

  test("registering same name twice throws", () => {
    const r = new Registry();
    r.counter("dupe", "first");
    expect(() => r.counter("dupe", "second")).toThrow();
  });
});

describe("instance identity + platform SLA series", () => {
  test("createRgsMetrics registers build_info and platform SLA metrics", async () => {
    const { createRgsMetrics } = await import("../src/metrics-rgs.js");
    const m = createRgsMetrics();
    m.buildInfo.set(1, {
      instance_id: "rgs-test1234", game: "g", core_version: "x", game_version: "y",
    });
    m.platformConnected.set(1);
    m.platformTransitions.inc(1, { direction: "down" });
    m.platformLastOk.set(1234567890);
    const text = m.registry.expose();
    expect(text).toContain('rgs_build_info{instance_id="rgs-test1234",game="g",core_version="x",game_version="y"} 1');
    expect(text).toContain("rgs_platform_connected 1");
    expect(text).toContain('rgs_platform_connection_transitions_total{direction="down"} 1');
    expect(text).toContain("rgs_platform_last_ok_timestamp_seconds 1234567890");
  });
});
