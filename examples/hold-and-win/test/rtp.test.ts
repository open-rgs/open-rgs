// CI test for the hold-&-win example: runs the committed play.wasm through the
// in-WASM batch simulator (no zig needed) and checks the math profile.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { simulateWasmBatch } from "../../../packages/simulator/src/index.js";

const WASM = resolve(import.meta.dir, "../maths/play.wasm");

describe("hold-and-win example (Zig WASM kernel)", () => {
  test("RTP ~= 96% and a sane profile over 5M spins", async () => {
    const r = await simulateWasmBatch(WASM, { spins: 5_000_000, seed: 1 });
    expect(r.name).toBe("hold-and-win");
    expect(r.spins).toBe(5_000_000);
    expect(Math.abs(r.rtp.measured - 0.96)).toBeLessThan(0.02); // tuned target
    expect(r.hitRate).toBeGreaterThan(0.25);
    expect(r.hitRate).toBeLessThan(0.36);
    expect(r.multiplier.max).toBeGreaterThan(100); // big wins occur
  });

  test("is deterministic for the same seed", async () => {
    const a = await simulateWasmBatch(WASM, { spins: 1_000_000, seed: 9 });
    const b = await simulateWasmBatch(WASM, { spins: 1_000_000, seed: 9 });
    expect(a.rtp.measured).toBe(b.rtp.measured);
  });
});
