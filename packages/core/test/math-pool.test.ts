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

describe("createMathPool (worker pool + terminate-on-timeout)", () => {
  test("runs WASM math in workers and returns valid outcomes (concurrently)", async () => {
    const pool = await createMathPool({ wasmPath: PLAY, size: 3 });
    try {
      expect(pool.name).toBe("wasm-demo");
      expect(pool.kind).toBe("simple");
      const outs = await Promise.all(Array.from({ length: 50 }, () => pool.play(undefined, ctx)));
      expect(outs).toHaveLength(50);
      for (const o of outs) {
        expect(typeof o.multiplier).toBe("number");
        expect(o.multiplier).toBeGreaterThanOrEqual(0);
      }
    } finally { pool.shutdown(); }
  }, 20_000);

  test("terminates a runaway kernel on timeout, then recovers", async () => {
    const pool = await createMathPool({ wasmPath: LOOP, size: 1, timeoutMs: 200 });
    try {
      const t0 = performance.now();
      await expect(pool.play(undefined, ctx)).rejects.toThrow(/MATH_TIMEOUT|budget/);
      const dt = performance.now() - t0;
      expect(dt).toBeGreaterThan(150);   // waited ~the budget, didn't return early
      expect(dt).toBeLessThan(3000);     // and didn't hang
      // The worker was killed + replaced; a SECOND call must also time out
      // cleanly (reject, not hang) - proving the pool didn't wedge.
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
