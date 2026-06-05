// Native simulator <-> WASM parity. The native binary (sim.zig) and the WASM
// kernel (play.wasm) share kernel.zig, so a single slice must be BYTE-IDENTICAL
// across the two targets - that's what makes the (unsandboxed, separate) native
// sim sound to certify against the shipped WASM. Requires zig to build the
// native binary; SKIPPED where zig is absent (e.g. CI runners), so it never
// blocks the suite.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const hasZig = Bun.which("zig") != null;
const dir = resolve(import.meta.dir, "../../core/test/fixtures/wasm");

describe("native sim <-> WASM parity (requires zig)", () => {
  test.skipIf(!hasZig)("native runSlice is byte-identical to WASM sim_batch", async () => {
    const build = Bun.spawnSync(["zig", "build-exe", "sim.zig", "-OReleaseFast", "-femit-bin=sim"], { cwd: dir });
    if (!build.success) throw new Error("zig build failed: " + build.stderr.toString());
    const sim = resolve(dir, "sim");

    const b = await Bun.file(resolve(dir, "play.wasm")).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(b, { host: { rng_next: () => 0, log_debug: () => {} } });
    const ex = instance.exports as Record<string, any>;
    const wasm = (N: number, hi: number, lo: number): number[] => {
      ex.reset?.(); const p = ex.alloc(48); ex.sim_batch(N, hi, lo, p);
      const dv = new DataView(ex.memory.buffer, p, 48);
      return [0, 8, 16, 24, 32, 40].map(o => dv.getFloat64(o, true));
    };
    const native = (N: number, hi: number, lo: number): number[] => {
      const r = Bun.spawnSync([sim, String(N), String(hi), String(lo), "1"]);
      if (!r.success) throw new Error("sim failed: " + r.stderr.toString());
      const j = JSON.parse(r.stdout.toString());
      return [j.count, j.sum, j.sumsq, j.min, j.max, j.hits];
    };

    for (const [N, hi, lo] of [[1_000_000, 12345, 67890], [300_000, 1, 0], [2_000_000, 0xdeadbeef, 0xcafef00d]] as const) {
      expect(native(N, hi >>> 0, lo >>> 0)).toEqual(wasm(N, hi >>> 0, lo >>> 0));
    }
  }, 60_000);
});
