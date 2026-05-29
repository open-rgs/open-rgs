// H10 — /healthz and the startup banner must report the real core version.
// The constant was hardcoded and went stale ("0.3.0" vs package 0.5.1),
// making health and audit logs lie. It now derives from package.json; this
// test fails if anyone re-hardcodes it out of sync.

import { describe, expect, test } from "bun:test";
import { CORE_VERSION } from "../src/version.js";
import pkg from "../package.json";

describe("CORE_VERSION (H10)", () => {
  test("matches package.json — never drifts", () => {
    expect(CORE_VERSION).toBe(pkg.version);
  });

  test("is a non-empty version string", () => {
    expect(typeof CORE_VERSION).toBe("string");
    expect(CORE_VERSION.length).toBeGreaterThan(0);
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
