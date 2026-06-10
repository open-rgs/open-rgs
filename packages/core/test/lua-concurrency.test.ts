// One math = one Lua VM, and a server runs that VM for the lifetime of the
// process across MANY sessions. The orchestrator-level suites mostly drive
// TS test maths, so the Lua dispatch path historically had no coverage for
// the two production shapes that have broken VM dispatch designs before:
//
// - ENDURANCE: hundreds of guarded calls on one VM. A per-call resource
//   leak in the dispatch path surfaces as a hard cliff (an earlier design
//   leaked one global-stack slot per call via wasmoon's callByteCode and
//   killed the VM at ~40 calls - WASM "Out of bounds memory access", then
//   "metatable not found: js_proxy" forever).
// - CONCURRENCY: different sessions invoking the same math concurrently.
//   The per-session lock upstream serializes ONE session only; the math
//   runtime must stay correct when calls from different sessions overlap.
//
// Money is fail-closed either way; what these tests protect is a pod's
// ability to serve traffic at all. They drive the public math surface
// exactly like the orchestrator does and require every call to succeed.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuaMath } from "../src/lua-math.js";
import type { SimpleMath } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));
const BURN = resolve(here, "fixtures/burn.lua");
const SIMPLE = resolve(here, "fixtures/simple.lua");

describe("guarded Lua invocation endurance", () => {
  test("300 sequential heavy play() calls on one VM", async () => {
    const m = (await loadLuaMath(BURN, { rng: () => 0.25, timeoutMs: 1000 })) as SimpleMath;
    for (let i = 0; i < 300; i++) {
      const out = await m.play(undefined, { mode: "default" });
      expect(out.multiplier).toBe(2);
    }
  });

  test("MATH_TIMEOUT aborts do not poison later calls on the same VM", async () => {
    const LOOP = resolve(here, "fixtures/loop.lua");
    const m = (await loadLuaMath(LOOP, { rng: () => 0.5, timeoutMs: 100 })) as SimpleMath;
    // The dispatch design may throw synchronously or reject - normalize via
    // an async wrapper, and pin the error to the watchdog, not corruption.
    const call = async () => m.play(undefined, { mode: "default" });
    await expect(call()).rejects.toHaveProperty("code", "MATH_TIMEOUT");
    // A second runaway call must still abort cleanly rather than corrupt.
    await expect(call()).rejects.toHaveProperty("code", "MATH_TIMEOUT");
  });
});

describe("concurrent Lua invocations on a shared VM", () => {
  test("32 concurrent play() calls (different sessions) all succeed", async () => {
    const m = (await loadLuaMath(BURN, { rng: () => 0.25, timeoutMs: 1000 })) as SimpleMath;
    const calls = Array.from({ length: 32 }, () =>
      Promise.resolve(m.play(undefined, { mode: "default" })),
    );
    const results = await Promise.allSettled(calls);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([]);
    for (const r of results) {
      expect((r as PromiseFulfilledResult<{ multiplier: number }>).value.multiplier).toBe(2);
    }
  });

  test("interleaved waves keep returning correct results", async () => {
    const m = (await loadLuaMath(SIMPLE, { rng: () => 0.75, timeoutMs: 1000 })) as SimpleMath;
    for (let wave = 0; wave < 5; wave++) {
      const calls = Array.from({ length: 16 }, () =>
        Promise.resolve(m.play(undefined, { mode: "default" })),
      );
      const results = await Promise.all(calls);
      for (const r of results) expect(r.multiplier).toBe(0); // rng 0.75 -> loss
    }
  });
});
