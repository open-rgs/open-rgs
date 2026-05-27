import { describe, expect, test } from "bun:test";
import { createDiagnostics } from "../src/index.js";

describe("createDiagnostics", () => {
  test("identity fields appear in snapshot", () => {
    const d = createDiagnostics({ adapter: "test", version: "1.0.0", gameId: "g1", endpoint: "wss://x" });
    const s = d.snapshot();
    expect(s["adapter"]).toBe("test");
    expect(s["version"]).toBe("1.0.0");
    expect(s["gameId"]).toBe("g1");
    expect(s["endpoint"]).toBe("wss://x");
    expect(s["connected"]).toBe(false);
  });

  test("noteConnect flips state and resets reconnect attempt", () => {
    const d = createDiagnostics({ adapter: "t", version: "0" });
    d.noteReconnectAttempt(); d.noteReconnectAttempt();
    expect(d.snapshot()["reconnect_attempt"]).toBe(2);
    d.noteConnect();
    expect(d.snapshot()["connected"]).toBe(true);
    expect(d.snapshot()["reconnect_attempt"]).toBe(0);
  });

  test("rpc counters increment/decrement", () => {
    const d = createDiagnostics({ adapter: "t", version: "0" });
    d.noteRpcStart(); d.noteRpcStart();
    expect(d.snapshot()["rpcs_in_flight"]).toBe(2);
    d.noteRpcDone(true);
    expect(d.snapshot()["rpcs_in_flight"]).toBe(1);
    expect(d.snapshot()["rpcs_settled"]).toBe(1);
    d.noteRpcDone(false);
    expect(d.snapshot()["rpcs_settled"]).toBe(1);
    expect(d.snapshot()["rpcs_failed"]).toBe(1);
  });

  test("extras flow into snapshot", () => {
    const d = createDiagnostics({ adapter: "t", version: "0" });
    d.setExtra("sessionId.last", "s-1");
    d.setExtra("upstream.seq", 42);
    const s = d.snapshot();
    expect(s["sessionId.last"]).toBe("s-1");
    expect(s["upstream.seq"]).toBe(42);
  });

  test("event count increments", () => {
    const d = createDiagnostics({ adapter: "t", version: "0" });
    for (let i = 0; i < 5; i++) d.noteEvent();
    expect(d.snapshot()["events_received"]).toBe(5);
  });
});
