// Replay: math is a pure function of (seed, carry), so a recorded round
// reconstructs exactly.
//
// The contract already claimed this for the Lua tier - "a call is fully
// reconstructable from its seed" - but nothing surfaced the seed, so the
// property was unusable. These tests assert the whole chain: the seed is
// exposed, replaying on it reproduces the outcome byte for byte, carry is part
// of the input, and a DIFFERENT seed genuinely produces something else (so the
// test is not passing because the math ignores randomness).

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadTsMath, type Replayable } from "../src/ts-math.js";
import type { SimpleMath, ComplexMath, MathModule } from "@open-rgs/contract";

async function fixture(body: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "open-rgs-replay-"));
  const p = resolve(dir, "m.ts");
  await writeFile(p, body, "utf8");
  return p;
}

/** Draw-heavy simple math that also folds the incoming carry into its result,
 *  so a replay must get BOTH the seed and the carry right to match. */
const DRAWY = `
  export default (host) => ({
    kind: "simple", name: "drawy", version: "1.0.0", rtp: 1,
    play: (prev) => {
      let acc = 0;
      for (let i = 0; i < 24; i++) acc += host.rng_next();
      const carried = prev ? Number(prev) : 0;
      return {
        multiplier: acc,
        ops: [{ kind: "spin", acc, carried }],
        type: "x",
        carry: String(carried + 1),
      };
    },
  });
`;

const ctx = { mode: "default" } as const;
const insecure = { rng: Math.random, allowInsecureRng: true } as const;

describe("seed-expand exposes a recordable seed", () => {
  test("lastSeed is a JSON-safe integer below 2^53", async () => {
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    await m.play(undefined, ctx);
    expect(Number.isInteger(m.lastSeed)).toBe(true);
    expect(m.lastSeed).toBeGreaterThanOrEqual(0);
    expect(m.lastSeed).toBeLessThan(2 ** 53);
    expect(JSON.parse(JSON.stringify({ s: m.lastSeed })).s).toBe(m.lastSeed);
  });

  test("each entry-point call reseeds independently", async () => {
    // Per-call reseeding is what lets one round be replayed in isolation
    // rather than replaying the whole session to reach it.
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    const seeds = new Set<number>();
    for (let i = 0; i < 50; i++) { await m.play(undefined, ctx); seeds.add(m.lastSeed); }
    expect(seeds.size).toBe(50);
  });
});

describe("replay reproduces a round exactly", () => {
  test("same seed + same carry -> identical outcome", async () => {
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;

    const original = await m.play("7", ctx);
    const seed = m.lastSeed;

    const replayed = await m.withSeed(seed, () => m.play("7", ctx));
    expect(replayed).toEqual(original);
  });

  test("replay survives other spins happening in between", async () => {
    // A real replay runs long after the round, on a process that has served
    // thousands of spins since.
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;

    const original = await m.play("3", ctx);
    const seed = m.lastSeed;
    for (let i = 0; i < 500; i++) await m.play(String(i), ctx);

    expect(await m.withSeed(seed, () => m.play("3", ctx))).toEqual(original);
  });

  test("a replay on a FRESH load of the same source still matches", async () => {
    // The seed must be portable across processes, not tied to one instance.
    const p = await fixture(DRAWY);
    const a = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    const original = await a.play("11", ctx);
    const seed = a.lastSeed;

    const b = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    expect(await b.withSeed(seed, () => b.play("11", ctx))).toEqual(original);
  });

  test("carry is part of the input - replaying with the wrong carry differs", async () => {
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    const original = await m.play("7", ctx);
    const seed = m.lastSeed;
    const wrong = await m.withSeed(seed, () => m.play("999", ctx));
    expect(wrong).not.toEqual(original);
  });

  test("a DIFFERENT seed produces a different outcome", async () => {
    // Guards against the whole suite passing because the math ignores rng.
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    const a = await m.withSeed(12345, () => m.play(undefined, ctx));
    const b = await m.withSeed(67890, () => m.play(undefined, ctx));
    expect(a).not.toEqual(b);
  });

  test("withSeed restores normal drawing afterwards", async () => {
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    await m.withSeed(42, () => m.play(undefined, ctx));
    expect(m.lastSeed).toBe(42);
    await m.play(undefined, ctx);
    expect(m.lastSeed).not.toBe(42);
  });
});

describe("complex rounds replay per entry point", () => {
  const COMPLEX = `
    export default (host) => ({
      kind: "complex", name: "c", version: "1.0.0", rtp: 1,
      open: () => ({ state: String(host.rng_next()), ops: [], multiplier: 0, type: "open" }),
      step: (state) => ({ state: state + ":" + host.rng_next(), ops: [], multiplier: 0, type: "step" }),
      isTerminal: (state) => state.split(":").length > 3,
      close: (state) => ({ multiplier: state.length, ops: [], type: "win" }),
    });
  `;

  test("open and step each get their own recordable seed", async () => {
    const p = await fixture(COMPLEX);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as ComplexMath & Replayable;

    const opened = await m.open(undefined, ctx);
    const openSeed = m.lastSeed;
    const stepped = await m.step(opened.state, { type: "go" });
    const stepSeed = m.lastSeed;

    expect(openSeed).not.toBe(stepSeed);
    expect(await m.withSeed(openSeed, () => m.open(undefined, ctx))).toEqual(opened);
    expect(await m.withSeed(stepSeed, () => m.step(opened.state, { type: "go" }))).toEqual(stepped);
  });

  test("isTerminal does not consume a seed", async () => {
    // A pure predicate over state. If asking whether a round is finished
    // reseeded, the next real call would land on a different stream and the
    // recorded seed would replay something else.
    const p = await fixture(COMPLEX);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as ComplexMath & Replayable;
    const opened = await m.open(undefined, ctx);
    const seedAfterOpen = m.lastSeed;
    m.isTerminal(opened.state);
    m.isTerminal(opened.state);
    expect(m.lastSeed).toBe(seedAfterOpen);
  });
});

describe("per-draw mode is unchanged", () => {
  test("default mode exposes no replay surface", async () => {
    // A CSPRNG has no seed to write down; pretending otherwise would be worse
    // than not offering it.
    const p = await fixture(DRAWY);
    const m = (await loadTsMath(p, insecure)) as MathModule & Partial<Replayable>;
    expect(m.lastSeed).toBeUndefined();
    expect(m.withSeed).toBeUndefined();
  });

  test("seed-expand still produces a well-spread stream", async () => {
    // Reproducible is worthless if it is also biased. The expansion is in the
    // outcome path, so it has to behave like a uniform source.
    const p = await fixture(`
      export default (host) => ({
        kind: "simple", name: "u", version: "1", rtp: 1,
        play: () => ({ multiplier: host.rng_next(), ops: [], type: "x" }),
      });
    `);
    const m = (await loadTsMath(p, { ...insecure, rngMode: "seed-expand" })) as SimpleMath & Replayable;
    const buckets = new Array(10).fill(0);
    const N = 100_000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const v = (await m.play(undefined, ctx)).multiplier;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
      sum += v;
    }
    expect(sum / N).toBeCloseTo(0.5, 2);
    for (const b of buckets) expect(b / N).toBeCloseTo(0.1, 2);
  });
});
