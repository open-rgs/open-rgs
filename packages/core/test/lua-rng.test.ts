// C5  - the math RNG determines real-money outcomes, so loadLuaMath must
// not silently fall back to Math.random in production. These tests pin the
// fail-closed behaviour and that an injected rng is actually the one used.

import { describe, expect, test, afterEach } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuaMath } from "../src/lua-math.js";
import type { SimpleMath } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));
const SIMPLE = resolve(here, "fixtures/simple.lua");

const savedEnv = process.env["NODE_ENV"];
afterEach(() => {
  if (savedEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = savedEnv;
});

describe("loadLuaMath RNG fail-closed (C5)", () => {
  test("production + no rng -> throws (refuses Math.random)", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(loadLuaMath(SIMPLE)).rejects.toThrow(/certified CSPRNG/);
  });

  test("production + allowInsecureRng -> loads (explicit opt-out)", async () => {
    process.env["NODE_ENV"] = "production";
    const m = await loadLuaMath(SIMPLE, { allowInsecureRng: true });
    expect(m.kind).toBe("simple");
  });

  test("production + injected rng -> loads and USES the injected rng", async () => {
    process.env["NODE_ENV"] = "production";
    const winMath = await loadLuaMath(SIMPLE, { rng: () => 0.1 }) as SimpleMath;
    const lossMath = await loadLuaMath(SIMPLE, { rng: () => 0.9 }) as SimpleMath;
    // The fixture: r < 0.5 -> multiplier 2, else 0. Proves our rng is wired.
    expect((await winMath.play(undefined, { mode: "default" })).multiplier).toBe(2);
    expect((await lossMath.play(undefined, { mode: "default" })).multiplier).toBe(0);
  });

  test("non-production + no rng -> loads with a warning (dev/sim fallback)", async () => {
    process.env["NODE_ENV"] = "development";
    const m = await loadLuaMath(SIMPLE);
    expect(m.kind).toBe("simple");
  });
});
