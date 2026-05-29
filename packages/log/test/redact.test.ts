// H11  - redaction was key-name-only with NO default set (so nothing was
// redacted by default), missed near-miss key variants, and never scrubbed
// secrets living in values (Bearer tokens, ?authToken=... URLs). These tests
// pin the hardened behaviour.

import { describe, expect, test } from "bun:test";
import { redactDeep, scrubString, buildRedactSet, DEFAULT_REDACT_KEYS } from "../src/redact.js";

const set = (extra?: string[]) => buildRedactSet(extra);

describe("redactDeep key matching (H11)", () => {
  test("default secret keys are redacted with no config", () => {
    const r = redactDeep({ password: "p", token: "t", authorization: "Bearer x", okay: "y" }, set()) as Record<string, unknown>;
    expect(r["password"]).toBe("[REDACTED]");
    expect(r["token"]).toBe("[REDACTED]");
    expect(r["authorization"]).toBe("[REDACTED]");
    expect(r["okay"]).toBe("y");
  });

  test("matching is separator- and case-insensitive (near-miss keys)", () => {
    const r = redactDeep(
      { authToken: "a", "X-Auth-Token": "b", auth_token: "c", "api.key": "d" },
      set(),
    ) as Record<string, unknown>;
    expect(r["authToken"]).toBe("[REDACTED]");
    expect(r["X-Auth-Token"]).toBe("[REDACTED]");
    expect(r["auth_token"]).toBe("[REDACTED]");
    expect(r["api.key"]).toBe("[REDACTED]");
  });

  test("a configured key catches all its separator variants", () => {
    const s = set(["player_id"]);
    const r = redactDeep({ "player.id": "1", playerId: "2", player_id: "3" }, s) as Record<string, unknown>;
    expect(r["player.id"]).toBe("[REDACTED]");
    expect(r["playerId"]).toBe("[REDACTED]");
    expect(r["player_id"]).toBe("[REDACTED]");
  });

  test("correlation ids stay readable by default (observability)", () => {
    const r = redactDeep({ "session.id": "sess-1", "round.id": "r-1" }, set()) as Record<string, unknown>;
    expect(r["session.id"]).toBe("sess-1");
    expect(r["round.id"]).toBe("r-1");
  });
});

describe("scrubString value-level scrubbing (H11)", () => {
  test("Bearer tokens are scrubbed", () => {
    expect(scrubString("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [REDACTED]");
  });

  test("sensitive URL query params are scrubbed, others kept", () => {
    const out = scrubString("connecting to wss://host/ws?authToken=SECRET123&game=spin");
    expect(out).not.toContain("SECRET123");
    expect(out).toContain("game=spin");
    expect(out).toContain("authToken=[REDACTED]");
  });

  test("inline password=... is scrubbed", () => {
    expect(scrubString("dsn=db://u:p@h?password=hunter2")).toContain("password=[REDACTED]");
    expect(scrubString("dsn=db://u:p@h?password=hunter2")).not.toContain("hunter2");
  });

  test("non-secret strings pass through unchanged", () => {
    expect(scrubString("round settled for 100 minor units")).toBe("round settled for 100 minor units");
  });
});

describe("redactDeep value scrubbing reaches nested strings (H11)", () => {
  test("a secret in a message / nested value is scrubbed", () => {
    const r = redactDeep({ message: "calling Bearer tok-xyz", nested: { url: "x?token=abc&y=1" } }, set()) as Record<string, unknown>;
    expect(r["message"]).toBe("calling Bearer [REDACTED]");
    const nested = r["nested"] as Record<string, unknown>;
    expect(nested["url"]).toBe("x?token=[REDACTED]&y=1");
  });
});

describe("DEFAULT_REDACT_KEYS", () => {
  test("is non-empty (redaction is on by default)", () => {
    expect(DEFAULT_REDACT_KEYS.length).toBeGreaterThan(0);
  });
});
