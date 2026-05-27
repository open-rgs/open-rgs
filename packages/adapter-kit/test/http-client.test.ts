import { describe, expect, test } from "bun:test";
import { HttpClient, createDiagnostics } from "../src/index.js";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpClient", () => {
  test("POSTs JSON to baseUrl + /<method> by default", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const c = new HttpClient({
      baseUrl: "https://upstream.example",
      fetch: async (url, init) => {
        captured = { url: String(url), init: init as RequestInit };
        return jsonResp({ ok: true });
      },
    });
    const r = await c.request<{ ok: boolean }>("settleSimple", { bet: 100 });
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://upstream.example/settleSimple");
    expect(captured?.init.method).toBe("POST");
    expect((captured?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(captured?.init.body).toBe(JSON.stringify({ bet: 100 }));
  });

  test("merges static headers", async () => {
    let captured: RequestInit | undefined;
    const c = new HttpClient({
      baseUrl: "https://x",
      headers: { "x-game-id": "g1", "authorization": "Bearer abc" },
      fetch: async (_url, init) => { captured = init as RequestInit; return jsonResp({}); },
    });
    await c.request("openSession", {});
    const hdr = captured?.headers as Record<string, string>;
    expect(hdr["x-game-id"]).toBe("g1");
    expect(hdr["authorization"]).toBe("Bearer abc");
  });

  test("pathFor override controls URL shape", async () => {
    let captured = "";
    const c = new HttpClient({
      baseUrl: "https://x",
      pathFor: (m) => `/api/v1/${m}.json`,
      fetch: async (url) => { captured = String(url); return jsonResp({}); },
    });
    await c.request("settleSimple", {});
    expect(captured).toBe("https://x/api/v1/settleSimple.json");
  });

  test("retries on 5xx then succeeds", async () => {
    let n = 0;
    const c = new HttpClient({
      baseUrl: "https://x",
      retries: 2,
      retryDelayMs: () => 1,
      fetch: async () => {
        n++;
        if (n < 3) return jsonResp({}, 503);
        return jsonResp({ ok: true });
      },
    });
    const r = await c.request<{ ok: boolean }>("flaky", {});
    expect(n).toBe(3);
    expect(r.ok).toBe(true);
  });

  test("throws on non-2xx after retries exhausted", async () => {
    const c = new HttpClient({
      baseUrl: "https://x",
      retries: 1,
      retryDelayMs: () => 1,
      fetch: async () => jsonResp({ err: "nope" }, 500),
    });
    await expect(c.request("permafail", {})).rejects.toThrow(/HTTP 500/);
  });

  test("throws on 4xx without retry", async () => {
    let n = 0;
    const c = new HttpClient({
      baseUrl: "https://x",
      retries: 3,
      fetch: async () => { n++; return jsonResp({ err: "bad" }, 400); },
    });
    await expect(c.request("badreq", {})).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });

  test("diagnostics counters update", async () => {
    const d = createDiagnostics({ adapter: "t", version: "0" });
    const c = new HttpClient({
      baseUrl: "https://x",
      diagnostics: d,
      fetch: async () => jsonResp({}),
    });
    await c.request("a", {});
    await c.request("b", {});
    expect(d.snapshot()["rpcs_settled"]).toBe(2);
    expect(d.snapshot()["rpcs_in_flight"]).toBe(0);
  });
});
