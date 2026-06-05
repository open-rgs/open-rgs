// Math worker pool: runs WASM math in worker threads off the I/O thread, with a
// per-call timeout enforced by terminate(). The security-critical test is that a
// RUNAWAY kernel is killed on timeout and the pool recovers (the fail-closed /
// no-DoS guarantee the bare loadWasmMath path lacks).

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createMathPool } from "../src/math-pool.js";
import type { SpinContext } from "@open-rgs/contract";

const PLAY = resolve(import.meta.dir, "fixtures/wasm/play.wasm");   // normal simple math
const LOOP = resolve(import.meta.dir, "fixtures/wasm/loop.wasm");   // play() loops forever
const ctx: SpinContext = { mode: "default" };

describe("createMathPool (worker pool: off-thread + round-level fail-closed)", () => {
  test("runs the REAL kernel across workers - outcomes match play.wasm's paytable", async () => {
    const pool = await createMathPool({ wasmPath: PLAY, size: 3 });
    try {
      expect(pool.name).toBe("wasm-demo");
      expect(pool.kind).toBe("simple");
      const outs = await Promise.all(Array.from({ length: 200 }, () => pool.play(undefined, ctx)));
      expect(outs).toHaveLength(200);
      // play.wasm's decide() pays EXACTLY one of these. Anything else means the
      // pool isn't faithfully running the kernel (stuck value, bad decode, wrong
      // worker) - which a `typeof === number, >= 0` check would have missed.
      const PAYOUTS = new Set([0, 0.5, 2, 50]);
      for (const o of outs) expect(PAYOUTS.has(o.multiplier)).toBe(true);
      // ...and it's actually producing varied outcomes, not one stuck value.
      expect(new Set(outs.map((o) => o.multiplier)).size).toBeGreaterThan(1);
    } finally { pool.shutdown(); }
  }, 20_000);

  test("a runaway round FAILS CLOSED at the budget and the pool recovers", async () => {
    // loop.wasm's play() never returns, so the ONLY way this call can settle is
    // the timeout firing - i.e. this asserts the fail-closed path runs at ~the
    // budget (not early, not hung). NOTE: this verifies the ROUND fails closed +
    // the pool stays usable; it does NOT verify the runaway THREAD is killed
    // (whether terminate() kills a tight loop is platform-dependent - see the
    // math-pool.ts header). That is the pool's honest scope.
    const pool = await createMathPool({ wasmPath: LOOP, size: 1, timeoutMs: 200 });
    try {
      const t0 = performance.now();
      await expect(pool.play(undefined, ctx)).rejects.toThrow(/MATH_TIMEOUT|budget/);
      const dt = performance.now() - t0;
      expect(dt).toBeGreaterThan(150);   // waited ~the budget, didn't return early
      expect(dt).toBeLessThan(3000);     // and didn't hang
      // The worker was dropped + replaced, so a SECOND call must also reject
      // cleanly (not hang) - proving the pool didn't wedge.
      await expect(pool.play(undefined, ctx)).rejects.toThrow(/MATH_TIMEOUT|budget/);
    } finally { pool.shutdown(); }
  }, 20_000);

  test("shutdown rejects in-flight work (doesn't hang)", async () => {
    const pool = await createMathPool({ wasmPath: LOOP, size: 1, timeoutMs: 10_000 });
    const inflight = pool.play(undefined, ctx); // worker starts spinning
    await new Promise(r => setTimeout(r, 50));   // let it be assigned
    pool.shutdown();                             // terminate mid-spin
    await expect(inflight).rejects.toThrow();
  }, 20_000);
});
