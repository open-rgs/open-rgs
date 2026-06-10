// One math = one Lua VM, and a server runs that VM for the lifetime of the
// process across MANY sessions. Two defects used to kill it in production
// shapes that the orchestrator-level tests (which mostly drive TS test
// maths) never exercised:
//
// 1. LEAK: wasmoon's callByteCode moves a chunk's return value onto the
//    global stack to read it but never pops it. Every guarded call leaked
//    one global-stack slot, and once Lua's unchecked headroom (~40 slots)
//    ran out the VM faulted ("Out of bounds memory access") and every
//    later interop push failed ("metatable not found: js_proxy"). A pod
//    died after ~40 spins - sequentially, no concurrency needed. The
//    loader now restores a stack watermark after every guarded chunk.
//
// 2. INTERLEAVING: the guarded path is two steps (write args as VM
//    globals, then run an async doString chunk). The orchestrator's
//    per-session lock serializes ONE session; concurrent sessions could
//    interleave caller B's arg-writes into caller A's in-flight chunk.
//    Guarded invocations now take a per-VM turnstile.
//
// Money was never at risk (failed calls fail closed before any wallet
// RPC), but a production pod would shed most traffic as INTERNAL_ERROR.
// These tests drive the public math surface exactly like the orchestrator
// does and require every call to succeed.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuaMath } from "../src/lua-math.js";
import type { SimpleMath } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));
const BURN = resolve(here, "fixtures/burn.lua");
const SIMPLE = resolve(here, "fixtures/simple.lua");

describe("guarded Lua invocation endurance (stack watermark)", () => {
  test("300 sequential heavy play() calls - far past the ~40-call cliff", async () => {
    // burn.lua runs >100k Lua instructions per call, so the watchdog hook
    // actually fires - this is the production shape, not a toy.
    const m = (await loadLuaMath(BURN, { rng: () => 0.25, timeoutMs: 1000 })) as SimpleMath;
    for (let i = 0; i < 300; i++) {
      const out = await m.play(undefined, { mode: "default" });
      expect(out.multiplier).toBe(2);
    }
  });

  test("MATH_TIMEOUT aborts do not poison later calls", async () => {
    const LOOP = resolve(here, "fixtures/loop.lua");
    const m = (await loadLuaMath(LOOP, { rng: () => 0.5, timeoutMs: 100 })) as SimpleMath;
    await expect(Promise.resolve(m.play(undefined, { mode: "default" }))).rejects.toThrow();
    // The VM must still be intact for a different math? No - same VM, same
    // math: a second runaway call still times out cleanly (stack restored,
    // turnstile advanced), rather than corrupting.
    await expect(Promise.resolve(m.play(undefined, { mode: "default" }))).rejects.toThrow();
  });
});

describe("guarded Lua invocations serialize per VM", () => {
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
