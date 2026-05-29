// C8 — the admin surface moves money (/admin/autoclose) and dumps balances
// (/admin/sessions), yet shipped unauthenticated, with wildcard CORS and
// suffix routing, on the public client port by default. These tests pin:
//   - sensitive routes require a Bearer token when one is configured;
//   - in production with no token they fail closed (403);
//   - probes stay open;
//   - routing is EXACT (no /wss/admin/* suffix injection);
//   - CORS is never wildcard.

import { describe, expect, test } from "bun:test";
import { createAdminHandler, type AdminConfig } from "../src/admin.js";
import {
  defineGame,
  type PlatformAdapter, type AutocloseResponse, type OrchestratorAPI,
} from "@open-rgs/contract";

const platform = {
  isHealthy: true,
  diagnostics: {},
} as unknown as PlatformAdapter;

const orchestrator = {
  autocloseRound: async (): Promise<AutocloseResponse> => ({ closed: true, roundId: "r1" }),
} as unknown as OrchestratorAPI;

const manifest = defineGame({
  id: "g", declaredRtp: 1, defaultMode: "base",
  modes: { base: { math: { kind: "simple", name: "m", version: "1", rtp: 1, play: () => ({ multiplier: 0, ops: [], type: "x" }) }, stakeMultiplier: 1 } },
});

function handler(extra: Partial<AdminConfig>) {
  return createAdminHandler({ manifest, platform, orchestrator, ...extra });
}
const get = (h: ReturnType<typeof handler>, path: string, headers?: Record<string, string>) =>
  h.fetch(new Request(`http://x${path}`, { headers }));

describe("admin auth (C8)", () => {
  test("with a token, /admin/sessions needs a matching Bearer", async () => {
    const h = handler({ authToken: "s3cret" });
    expect((await get(h, "/admin/sessions"))!.status).toBe(401);
    expect((await get(h, "/admin/sessions", { authorization: "Bearer wrong" }))!.status).toBe(401);
    expect((await get(h, "/admin/sessions", { authorization: "Bearer s3cret" }))!.status).toBe(200);
  });

  test("autoclose (money move) is gated too", async () => {
    const h = handler({ authToken: "s3cret" });
    const unauth = await h.fetch(new Request("http://x/admin/autoclose", { method: "POST", body: "{}" }));
    expect(unauth!.status).toBe(401);
  });

  test("production with no token fails closed (403)", async () => {
    const h = handler({ requireAuth: true });
    expect((await get(h, "/admin/sessions"))!.status).toBe(403);
    expect((await get(h, "/healthz"))!.status).toBe(403);
  });

  test("dev with no token serves openly (back-compat)", async () => {
    const h = handler({ requireAuth: false });
    expect((await get(h, "/admin/sessions"))!.status).toBe(200);
  });

  test("k8s probes are always open", async () => {
    const h = handler({ requireAuth: true, authToken: "s3cret" });
    expect((await get(h, "/livez"))!.status).toBe(200);
    expect((await get(h, "/readyz"))!.status).toBe(200);
  });
});

describe("admin /admin/logs ?limit handling (L5)", () => {
  test("a non-numeric ?limit doesn't break the route", async () => {
    const h = handler({ requireAuth: false });
    const res = (await get(h, "/admin/logs?limit=notanumber"))!;
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });
  test("a valid ?limit is honored", async () => {
    const h = handler({ requireAuth: false });
    expect((await get(h, "/admin/logs?limit=10"))!.status).toBe(200);
  });
});

describe("admin routing is exact (C8)", () => {
  test("suffix-injected paths no longer reach the handler", async () => {
    const h = handler({ requireAuth: true, authToken: "s3cret" });
    // Previously `/wss/admin/sessions` suffix-matched /admin/sessions.
    expect(await get(h, "/wss/admin/sessions", { authorization: "Bearer s3cret" })).toBeUndefined();
    expect(await get(h, "/api/example-game/admin/autoclose")).toBeUndefined();
  });

  test("a declared routeBasePath matches exactly", async () => {
    const h = handler({ authToken: "s3cret", routeBasePath: "/api" });
    expect((await get(h, "/api/admin/sessions", { authorization: "Bearer s3cret" }))!.status).toBe(200);
    expect(await get(h, "/admin/sessions", { authorization: "Bearer s3cret" })).toBeUndefined();
  });
});

describe("admin CORS is never wildcard (C8)", () => {
  test("no allowlist → no CORS header", async () => {
    const h = handler({ requireAuth: false });
    const res = (await get(h, "/admin/sessions", { origin: "https://evil.example" }))!;
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allowlisted origin is echoed; others are not", async () => {
    const h = handler({ requireAuth: false, allowedOrigins: ["https://ops.example"] });
    const ok = (await get(h, "/admin/sessions", { origin: "https://ops.example" }))!;
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://ops.example");
    const bad = (await get(h, "/admin/sessions", { origin: "https://evil.example" }))!;
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});
