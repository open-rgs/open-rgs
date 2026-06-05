// loadWasmMath: load a .wasm math kernel (spec 03 ABI), inject the rng as the
// host.rng_next import, and msgpack-decode outcomes. Fixture: fixtures/wasm/
// play.wasm (built from play.zig; committed so CI needs no zig toolchain).

import { describe, expect, test, afterEach } from "bun:test";
import { resolve } from "node:path";
import { loadWasmMath } from "../src/wasm-math.js";
import type { SimpleMath, SpinContext } from "@open-rgs/contract";

const WASM = resolve(import.meta.dir, "fixtures/wasm/play.wasm");
const ctx: SpinContext = { mode: "default" };

const savedEnv = process.env["NODE_ENV"];
afterEach(() => { if (savedEnv === undefined) delete process.env["NODE_ENV"]; else process.env["NODE_ENV"] = savedEnv; });

describe("loadWasmMath", () => {
  test("reads metadata from the kernel exports", async () => {
    const m = await loadWasmMath(WASM, { rng: () => 0.5 }) as SimpleMath;
    expect(m.kind).toBe("simple");
    expect(m.name).toBe("wasm-demo");
    expect(m.version).toBe("1.0.0");
    expect(m.rtp).toBeCloseTo(0.85, 5);
    expect(m.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("play uses the injected rng and decodes the msgpack outcome", async () => {
    const cases: Array<[number, number, string]> = [
      [0.10, 0.5, "win"],    // r < 0.30
      [0.35, 2.0, "win"],    // r < 0.40
      [0.405, 50.0, "win"],  // r < 0.41
      [0.90, 0, "loss"],
    ];
    for (const [r, mult, type] of cases) {
      const m = await loadWasmMath(WASM, { rng: () => r }) as SimpleMath;
      const o = await m.play(undefined, ctx);
      expect(o.multiplier).toBe(mult);
      expect(o.type).toBe(type);
      expect(o.ops).toEqual([]);
    }
  });

  test("measured RTP over many spins matches declared (0.85)", async () => {
    let i = 0;
    const rng = () => { i = (i + 1) % 1000; return i / 1000; }; // uniform 0.000..0.999
    const m = await loadWasmMath(WASM, { rng }) as SimpleMath;
    let sum = 0; const N = 100_000;
    for (let k = 0; k < N; k++) sum += (await m.play(undefined, ctx)).multiplier;
    expect(Math.abs(sum / N - 0.85)).toBeLessThan(0.02); // 0.30*0.5 + 0.10*2 + 0.01*50
  });

  test("shares the secure-RNG policy: fails closed in production without an rng", async () => {
    process.env["NODE_ENV"] = "production";
    await expect(loadWasmMath(WASM)).rejects.toThrow(/choose its outcome RNG|cryptoRng/);
  });

  test("default (dev, no rng) uses the secure CSPRNG and runs", async () => {
    process.env["NODE_ENV"] = "development";
    const m = await loadWasmMath(WASM) as SimpleMath;
    const o = await m.play(undefined, ctx);
    expect(typeof o.multiplier).toBe("number");
    expect(o.multiplier).toBeGreaterThanOrEqual(0);
  });
});
