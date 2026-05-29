// C7 — wasmoon runs Lua synchronously on the single thread, so a math with
// an infinite loop hangs the whole server for every player and no JS timer
// can interrupt it. The loader installs a Lua instruction hook that aborts
// a call once it passes its wall-clock budget. These tests prove a runaway
// math is killed with MATH_TIMEOUT and that normal math is unaffected.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuaMath } from "../src/lua-math.js";
import { RGSError } from "@open-rgs/contract";
import type { SimpleMath } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));
const LOOP = resolve(here, "fixtures/loop.lua");
const SIMPLE = resolve(here, "fixtures/simple.lua");

describe("Lua execution watchdog (C7)", () => {
  test("a runaway play() is aborted with MATH_TIMEOUT, not a hang", async () => {
    // Short budget so the test is fast. loadLuaMath returns fine (the loop
    // is inside play, not at load); calling play trips the deadline.
    const m = (await loadLuaMath(LOOP, { rng: () => 0.5, timeoutMs: 150 })) as SimpleMath;
    const start = performance.now();
    let err: unknown;
    try { await m.play(undefined, { mode: "default" }); }
    catch (e) { err = e; }
    const elapsed = performance.now() - start;
    expect(err).toBeInstanceOf(RGSError);
    expect((err as RGSError).code).toBe("MATH_TIMEOUT");
    // Aborted near the budget, nowhere near forever.
    expect(elapsed).toBeLessThan(3000);
  });

  test("normal math runs fine under the watchdog", async () => {
    const m = (await loadLuaMath(SIMPLE, { rng: () => 0.1, timeoutMs: 1000 })) as SimpleMath;
    const out = await m.play(undefined, { mode: "default" });
    expect(out.multiplier).toBe(2); // rng 0.1 < 0.5 → win
  });
});
