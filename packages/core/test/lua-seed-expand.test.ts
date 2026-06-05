// rngMode "seed-expand" (#9): draw one seed per call and expand it in-VM with
// xoshiro256++, so the math draws with no per-draw JS<->WASM crossing. Verifies
// the crossing reduction, determinism, unbiased RTP, and that the generator is
// hidden from the (untrusted) math. Default mode ("per-draw") is unchanged.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadLuaMath } from "../src/lua-math.js";
import type { SimpleMath, SpinContext } from "@open-rgs/contract";

const MULTI = resolve(import.meta.dir, "fixtures/multi-draw.lua"); // 10 draws/spin, RTP 0.5
const PROBE = resolve(import.meta.dir, "fixtures/seed-probe.lua");
const ctx: SpinContext = { mode: "default" };

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function play(m: SimpleMath, n: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await Promise.resolve(m.play(undefined, ctx))).multiplier);
  return out;
}

describe("rngMode seed-expand (#9)", () => {
  test("draws a FIXED 2 seed values per call regardless of draws-per-spin", async () => {
    let perDraw = 0;
    let seedExp = 0;
    const mPer = await loadLuaMath(MULTI, { rng: () => { perDraw++; return 0.4; } }) as SimpleMath;
    const mSeed = await loadLuaMath(MULTI, { rng: () => { seedExp++; return 0.4; }, rngMode: "seed-expand" }) as SimpleMath;
    const atLoad = seedExp; // initial reseed during load (one 64-bit seed = 2 u32 draws)
    await play(mPer, 100);
    await play(mSeed, 100);
    expect(perDraw).toBe(100 * 10);            // per-draw: one rng() per draw (10/spin)
    expect(seedExp - atLoad).toBe(100 * 2);    // seed-expand: 2 (one 64-bit reseed) per call, fixed
    expect(atLoad).toBe(2);                     // one reseed at load
  });

  test("is deterministic for the same seed stream", async () => {
    const a = await loadLuaMath(MULTI, { rng: mulberry32(99), rngMode: "seed-expand" }) as SimpleMath;
    const b = await loadLuaMath(MULTI, { rng: mulberry32(99), rngMode: "seed-expand" }) as SimpleMath;
    expect(await play(a, 200)).toEqual(await play(b, 200));
  });

  test("RTP is unbiased (~0.5) over many spins", async () => {
    const N = 20_000;
    const m = await loadLuaMath(MULTI, { rng: mulberry32(7), rngMode: "seed-expand" }) as SimpleMath;
    const outs = await play(m, N);
    const rtp = outs.reduce((a, b) => a + b, 0) / N;
    expect(Math.abs(rtp - 0.5)).toBeLessThan(0.03); // SE ~0.0035; this is ~8 sigma
  });

  test("hides the generator from the math (cannot reseed or peek)", async () => {
    const m = await loadLuaMath(PROBE, { rng: () => 0.5, rngMode: "seed-expand" }) as SimpleMath;
    const o = await Promise.resolve(m.play(undefined, ctx));
    expect(o.multiplier).toBe(0); // 1 would mean __open_rgs_xoshiro_* leaked into the sandbox
  });

  test("default mode (no rngMode) stays per-draw", async () => {
    let calls = 0;
    const m = await loadLuaMath(MULTI, { rng: () => { calls++; return 0.4; } }) as SimpleMath;
    await play(m, 10);
    expect(calls).toBe(10 * 10);
  });
});
