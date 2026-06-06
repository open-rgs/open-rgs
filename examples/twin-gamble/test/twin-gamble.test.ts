// CI gate for the twin-gamble pair. Three claims:
//   1. PARITY - the Lua math (maths/gamble.lua) and the Zig/WASM math
//      (maths/gamble.wasm) produce IDENTICAL open -> step* -> close lifecycles
//      for the same RNG stream, across many seeds and gamble policies.
//   2. FAIR GAMBLE - the round's RTP is policy-invariant (~0.96 whether you
//      gamble 0, 1, 2, or 3 times), proven by in-WASM self-play. Gambling moves
//      VARIANCE (max win 2 -> 16 -> 512), not edge.
//   3. LIFECYCLE - the state machine behaves (collect, bust, losing open, cap).
//
// On claim 2 we only assert RTP at depths that actually converge. A fair gamble
// is EV-neutral at ANY depth by construction, but deep gambles are so
// high-variance that a tight Monte-Carlo RTP check would be flaky - so we test
// the flat edge where it converges and the growing variance throughout, rather
// than asserting a number we can't actually pin down. (See the README.)

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { loadLuaMath, loadWasmMath } from "../../../packages/core/src/index.js";
import type { ComplexMath, PlayerAction } from "../../../packages/contract/src/index.js";

const LUA = resolve(import.meta.dir, "../maths/gamble.lua");
const WASM = resolve(import.meta.dir, "../maths/gamble.wasm");
const ctx = { mode: "default" } as const;
const GAMBLE: PlayerAction = { type: "gamble" };

// Deterministic DEV-ONLY PRNG so both runtimes draw the SAME stream.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Scripted RNG for lifecycle tests (last value repeats).
function seq(vals: number[]): () => number {
  let i = 0;
  return () => vals[Math.min(i++, vals.length - 1)]!;
}

// Drive a full round under the policy "gamble up to maxSteps times, then close".
// Returns only OBSERVABLE outcomes - never the opaque `state`, which each runtime
// encodes its own way (Lua: a "g,d,w" string; Zig: an 8-byte blob).
async function drive(m: ComplexMath, maxSteps: number): Promise<unknown[]> {
  const trace: unknown[] = [];
  const o = await m.open(undefined, ctx);
  trace.push({ phase: "open", ops: o.ops, awaiting: o.awaiting?.type ?? null });
  let state = o.state;
  let steps = 0;
  while (!(await m.isTerminal(state)) && steps < maxSteps) {
    const s = await m.step(state, GAMBLE);
    state = s.state;
    steps++;
    trace.push({ phase: "step", ops: s.ops, awaiting: s.awaiting?.type ?? null });
  }
  const terminal = await m.isTerminal(state);
  const c = await m.close(state);
  trace.push({ phase: "close", multiplier: c.multiplier, type: c.type, terminal });
  return trace;
}

interface SimExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  reset(): void;
  sim_gamble(spins: number, seedHi: number, seedLo: number, stopAfter: number, outP: number): void;
}

describe("twin-gamble: Lua and Zig are 1:1", () => {
  test("identical lifecycles for the same RNG stream (16 seeds x 5 policies)", async () => {
    for (const seed of [1, 2, 3, 7, 11, 42, 99, 123, 777, 1000, 5, 8, 13, 21, 314, 2718]) {
      for (const maxSteps of [0, 1, 3, 8, 99]) {
        // Fresh, identically-seeded generators: open draws 1, each step draws 1,
        // close/is_terminal draw 0 - so both runtimes consume the same stream.
        const lua = (await loadLuaMath(LUA, { rng: mulberry32(seed), timeoutMs: 0 })) as ComplexMath;
        const wasm = (await loadWasmMath(WASM, { rng: mulberry32(seed) })) as ComplexMath;
        expect(await drive(lua, maxSteps)).toEqual(await drive(wasm, maxSteps));
      }
    }
  });

  test("both declare the same metadata", async () => {
    const lua = (await loadLuaMath(LUA, { rng: mulberry32(1) })) as ComplexMath;
    const wasm = (await loadWasmMath(WASM, { rng: mulberry32(1) })) as ComplexMath;
    expect(lua.kind).toBe("complex");
    expect(wasm.kind).toBe("complex");
    expect(lua.name).toBe("twin-gamble");
    expect(wasm.name).toBe("twin-gamble");
  });
});

describe("twin-gamble: the fair gamble is EV-neutral", () => {
  // Helper: one in-WASM self-play aggregate under the "stop after N gambles" policy.
  async function agg(spins: number, stop: number, seed: number): Promise<{ rtp: number; max: number }> {
    const bytes = await readFile(WASM);
    const { instance } = await WebAssembly.instantiate(bytes, { host: { rng_next: () => 0, log_debug: () => {} } });
    const ex = instance.exports as unknown as SimExports;
    ex.reset();
    const p = ex.alloc(48);
    ex.sim_gamble(spins, 0x9e3779b9, seed, stop, p);
    const dv = new DataView(ex.memory.buffer, p, 48);
    return { rtp: dv.getFloat64(8, true) / dv.getFloat64(0, true), max: dv.getFloat64(32, true) };
  }

  test("RTP stays ~0.96 across every converging depth (stop@0..3)", async () => {
    for (const stop of [0, 1, 2, 3]) {
      const { rtp } = await agg(10_000_000, stop, stop + 1);
      expect(rtp).toBeCloseTo(0.96, 2); // edge is flat: gambling doesn't change it
    }
  });

  test("gambling grows variance, not edge (max win 2 -> 16 -> 512)", async () => {
    // Max is structural (base 2 doubled N times) and reliably reached at 10M.
    expect((await agg(10_000_000, 0, 1)).max).toBe(2); //   no gamble:  2
    expect((await agg(10_000_000, 3, 1)).max).toBe(16); //  3 gambles: 2*2^3
    expect((await agg(10_000_000, 8, 1)).max).toBe(512); // 8 gambles: 2*2^8
  });
});

describe("twin-gamble: lifecycle", () => {
  test("collect the base win without gambling", async () => {
    const m = (await loadWasmMath(WASM, { rng: seq([0.0]) })) as ComplexMath; // base = 2
    const o = await m.open(undefined, ctx);
    expect(o.awaiting?.type).toBe("gamble");
    expect(await m.isTerminal(o.state)).toBe(false);
    const c = await m.close(o.state); // close = collect, no step
    expect(c.multiplier).toBe(2);
    expect(c.type).toBe("win");
  });

  test("a bust pays 0 and is terminal", async () => {
    const m = (await loadWasmMath(WASM, { rng: seq([0.0, 0.99]) })) as ComplexMath; // base 2, then tails
    const o = await m.open(undefined, ctx);
    const s = await m.step(o.state, GAMBLE);
    expect(s.awaiting).toBeUndefined();
    expect(await m.isTerminal(s.state)).toBe(true);
    const c = await m.close(s.state);
    expect(c.multiplier).toBe(0);
    expect(c.type).toBe("loss");
  });

  test("a losing spin is terminal at open (nothing to gamble)", async () => {
    const m = (await loadWasmMath(WASM, { rng: seq([0.9]) })) as ComplexMath; // base = 0
    const o = await m.open(undefined, ctx);
    expect(o.awaiting).toBeUndefined();
    expect(await m.isTerminal(o.state)).toBe(true);
    expect((await m.close(o.state)).multiplier).toBe(0);
  });

  test("the gamble caps at 8 wins (512x) then is terminal", async () => {
    const m = (await loadWasmMath(WASM, { rng: seq([0.0]) })) as ComplexMath; // base 2, all heads
    let state = (await m.open(undefined, ctx)).state;
    for (let k = 0; k < 8; k++) {
      expect(await m.isTerminal(state)).toBe(false);
      state = (await m.step(state, GAMBLE)).state;
    }
    expect(await m.isTerminal(state)).toBe(true); // capped
    const c = await m.close(state);
    expect(c.multiplier).toBe(512); // 2 * 2^8
    expect(c.type).toBe("win");
  });
});
