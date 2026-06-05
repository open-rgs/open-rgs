// CI gate for the cash-ladder complex Zig example: a full open -> step -> close
// lifecycle through loadWasmMath, plus the bust path.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadWasmMath } from "../../../packages/core/src/index.js";
import type { ComplexMath } from "../../../packages/contract/src/index.js";

const WASM = resolve(import.meta.dir, "../maths/play.wasm");
const ctx = { mode: "default" } as const;

interface LadderExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(): void;
  sim_ladder(spins: number, seedHi: number, seedLo: number, stopLevel: number, outP: number): void;
}

describe("cash-ladder (complex Zig kernel)", () => {
  test("open -> climb x3 -> cash out pays > 1x", async () => {
    const m = (await loadWasmMath(WASM, { rng: () => 0.99 })) as ComplexMath; // never busts
    expect(m.kind).toBe("complex");
    const o = await m.open(undefined, ctx);
    expect(o.awaiting?.type).toBe("climb");
    let state = o.state;
    for (let k = 0; k < 3; k++) state = (await m.step(state, { type: "climb" })).state;
    expect(await m.isTerminal(state)).toBe(false);
    const c = await m.close(state);
    expect(c.type).toBe("cashout");
    expect(c.multiplier).toBeGreaterThan(1);
  });

  test("a bust is terminal and pays 0", async () => {
    const m = (await loadWasmMath(WASM, { rng: () => 0.01 })) as ComplexMath; // always busts
    const o = await m.open(undefined, ctx);
    const s = await m.step(o.state, { type: "climb" });
    expect(s.awaiting).toBeUndefined();
    expect(await m.isTerminal(s.state)).toBe(true);
    const c = await m.close(s.state);
    expect(c.multiplier).toBe(0);
  });
});

describe("cash-ladder in-kernel self-play (sim_ladder policy sweep)", () => {
  test("measured RTP matches the policy: stop@0 = 1.0, stop@1 ~ 0.96", async () => {
    const bytes = await readFile(WASM);
    const { instance } = await WebAssembly.instantiate(bytes, { host: { rng_next: () => 0, log_debug: () => {} } });
    const ex = instance.exports as unknown as LadderExports;
    const rtp = (spins: number, stop: number, seed: number): number => {
      ex.reset();
      const p = ex.alloc(48);
      ex.sim_ladder(spins, 0x9e3779b9, seed, stop, p);
      const dv = new DataView(ex.memory.buffer, p, 48);
      return dv.getFloat64(8, true) / dv.getFloat64(0, true); // sum / count
    };
    expect(rtp(100_000, 0, 1)).toBe(1); // don't gamble -> exactly 1.0x
    expect(rtp(2_000_000, 1, 2)).toBeCloseTo(0.96, 2); // one climb -> ~0.96 (0.75 x 1.28)
    expect(rtp(2_000_000, 2, 3)).toBeCloseTo(0.9216, 2); // two climbs -> ~0.96^2
  });
});
