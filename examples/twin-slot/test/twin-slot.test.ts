// CI gate for the twin-slot pair. Two claims:
//   1. PARITY - the Lua math (maths/slot.lua) and the Zig/WASM math
//      (maths/slot.wasm) return identical outcomes for the same RNG stream.
//      This is the whole point of the pair, so we assert it hard: thousands of
//      spins across several seeds, full-outcome equality.
//   2. RTP - the slot pays ~0.96, measured by the kernel's in-WASM self-play
//      (exact + fast). The Lua twin inherits that RTP *by parity* (claim 1), so
//      we don't separately Monte-Carlo the slower Lua path.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadLuaMath, loadWasmMath } from "../../../packages/core/src/index.js";
import type { SimpleMath } from "../../../packages/contract/src/index.js";

const LUA = resolve(import.meta.dir, "../maths/slot.lua");
const WASM = resolve(import.meta.dir, "../maths/slot.wasm");
const ctx = { mode: "default" } as const;

// Deterministic DEV-ONLY PRNG so both runtimes draw the SAME stream. Real
// outcomes must use a CSPRNG (loadXMath defaults to cryptoRng); this is a test
// fixture, never a production source.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(): void;
  sim_batch(spins: number, seedHi: number, seedLo: number, outP: number): void;
}

describe("twin-slot: Lua and Zig are 1:1", () => {
  test("identical outcomes for the same RNG stream (20k spins, 5 seeds)", async () => {
    for (const seed of [1, 7, 42, 123, 1000]) {
      // Fresh, identically-seeded generators: each draws one value per play(),
      // so the two runtimes see the same stream and must agree spin-for-spin.
      const lua = (await loadLuaMath(LUA, { rng: mulberry32(seed), timeoutMs: 0 })) as SimpleMath;
      const wasm = (await loadWasmMath(WASM, { rng: mulberry32(seed) })) as SimpleMath;
      for (let i = 0; i < 4000; i++) {
        const a = await lua.play(undefined, ctx);
        const b = await wasm.play(undefined, ctx);
        expect(a).toEqual(b); // multiplier + ops + type all match
      }
    }
  });

  test("both declare the same metadata", async () => {
    const lua = (await loadLuaMath(LUA, { rng: mulberry32(1) })) as SimpleMath;
    const wasm = (await loadWasmMath(WASM, { rng: mulberry32(1) })) as SimpleMath;
    expect(lua.kind).toBe("simple");
    expect(wasm.kind).toBe("simple");
    expect(lua.name).toBe("twin-slot");
    expect(wasm.name).toBe("twin-slot");
    expect(lua.rtp).toBe(0.96);
    expect(wasm.rtp).toBe(0.96);
  });
});

describe("twin-slot: RTP and payouts", () => {
  test("in-WASM self-play measures RTP ~0.96 (and Lua inherits it by parity)", async () => {
    const bytes = await readFile(WASM);
    const { instance } = await WebAssembly.instantiate(bytes, { host: { rng_next: () => 0, log_debug: () => {} } });
    const ex = instance.exports as unknown as SimExports;
    ex.reset();
    const p = ex.alloc(48);
    ex.sim_batch(4_000_000, 0x9e3779b9, 1, p);
    const dv = new DataView(ex.memory.buffer, p, 48);
    const count = dv.getFloat64(0, true);
    const sum = dv.getFloat64(8, true);
    const max = dv.getFloat64(32, true);
    const hits = dv.getFloat64(40, true);
    expect(sum / count).toBeCloseTo(0.96, 2); // RTP
    expect(hits / count).toBeCloseTo(0.42, 2); // hit rate = 0.02 + 0.04 + 0.36
    expect(max).toBe(20); // top paytable rung
  });

  test("only ever pays the paytable multipliers {0, 1, 5, 20}", async () => {
    const wasm = (await loadWasmMath(WASM, { rng: mulberry32(12345) })) as SimpleMath;
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const m = (await wasm.play(undefined, ctx)).multiplier;
      expect([0, 1, 5, 20]).toContain(m);
      seen.add(m);
    }
    expect([...seen].sort((x, y) => x - y)).toEqual([0, 1, 5, 20]); // all rungs appear
  });
});
