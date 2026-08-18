// loadTsMath: the RNG seam and the purity gate.
//
// The purity gate is the reason this tier is safe to promote from "prototyping"
// to production. Each denial below corresponds to a real way a TS math can
// silently void a certified RTP, so each gets its own case - and the accept
// cases matter just as much, because a checker that rejects `Math.floor` or a
// comment mentioning `Math.random` would be abandoned within a day.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { assertPure, loadTsMath } from "../src/ts-math.js";
import type { SimpleMath } from "@open-rgs/contract";

const P = "test.ts";
const pure = (src: string) => () => assertPure(src, P);

describe("assertPure - denies what breaks reproducibility", () => {
  test("ambient randomness", () => {
    expect(pure("const r = Math.random();")).toThrow(/ambient randomness/);
    expect(pure("crypto.getRandomValues(b);")).toThrow(/ambient randomness/);
  });

  test("the clock", () => {
    expect(pure("const t = Date.now();")).toThrow(/the clock/);
    expect(pure("const t = performance.now();")).toThrow(/the clock/);
  });

  test("I/O", () => {
    expect(pure("await fetch('http://x');")).toThrow(/I\/O/);
    expect(pure("const k = process.env.KEY;")).toThrow(/I\/O/);
    expect(pure("const m = await import('./x.js');")).toThrow(/I\/O/);
  });

  test("dynamic escape hatches", () => {
    expect(pure("globalThis.x = 1;")).toThrow(/escape hatch/);
    expect(pure("eval('1+1');")).toThrow(/escape hatch/);
    expect(pure("const f = new Function('return 1');")).toThrow(/escape hatch/);
  });

  test("implementation-defined float ops", () => {
    // Not specified to bit precision - an RTP certified on one engine build
    // would not reproduce on another.
    expect(pure("const x = Math.pow(2, 3);")).toThrow(/implementation-defined/);
    expect(pure("const x = Math.sin(1);")).toThrow(/implementation-defined/);
    expect(pure("const x = Math.log(1);")).toThrow(/implementation-defined/);
  });

  test("the message names the guarantee, not just the identifier", () => {
    expect(pure("Math.random()")).toThrow(/host\.rng_next/);
    expect(pure("Math.pow(2,3)")).toThrow(/loadWasmMath/);
  });
});

describe("assertPure - accepts real math", () => {
  test("correctly-rounded float ops are fine", () => {
    // These ARE specified exactly, so they reproduce across engines.
    expect(pure("const x = Math.floor(1.5) + Math.abs(-1) + Math.min(1,2) + Math.sqrt(4);")).not.toThrow();
    expect(pure("const x = Math.max(1,2) + Math.round(1.4) + Math.trunc(1.9) + Math.sign(-3);")).not.toThrow();
  });

  test("a denied term inside a comment does not trip the gate", () => {
    expect(pure("// never call Math.random() here\nconst r = host.rng_next();")).not.toThrow();
    expect(pure("/* Date.now() is forbidden */ const r = host.rng_next();")).not.toThrow();
  });

  test("a denied term inside a quoted string does not trip the gate", () => {
    expect(pure(`const msg = "Math.random is not available";`)).not.toThrow();
    expect(pure(`const msg = 'use host.rng_next, not Date.now';`)).not.toThrow();
  });

  test("code inside a template hole IS still scanned", () => {
    // Stripping whole template literals would hide real code in ${...}.
    expect(pure("const s = `roll ${Math.random()}`;")).toThrow(/ambient randomness/);
  });

  test("the twin-slot TS math is pure", async () => {
    const src = await Bun.file(resolve(import.meta.dir, "../../../examples/twin-slot/maths/slot.ts")).text();
    expect(() => assertPure(src, "slot.ts")).not.toThrow();
  });
});

async function fixture(name: string, body: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "open-rgs-ts-math-"));
  const p = resolve(dir, name);
  await writeFile(p, body, "utf8");
  return p;
}

describe("loadTsMath", () => {
  const rng = () => 0.01; // always the top band of twin-slot's ladder

  test("injects the host and draws through it", async () => {
    const draws: number[] = [];
    const p = await fixture("m.ts", `
      export default (host) => ({
        kind: "simple", name: "m", version: "1.0.0", rtp: 1,
        play: () => ({ multiplier: host.rng_next() < 0.5 ? 2 : 0, ops: [], type: "x" }),
      });
    `);
    const seq = [0.1, 0.9];
    let i = 0;
    const math = (await loadTsMath(p, { rng: () => { const v = seq[i++]!; draws.push(v); return v; } })) as SimpleMath;
    expect((await math.play(undefined, { mode: "default" })).multiplier).toBe(2);
    expect((await math.play(undefined, { mode: "default" })).multiplier).toBe(0);
    expect(draws).toEqual(seq); // math had no other source of randomness
  });

  test("rejects a bare object default export - no RNG seam", async () => {
    const p = await fixture("bare.ts", `
      export default { kind: "simple", name: "b", version: "1", rtp: 1, play: () => ({ multiplier: 0, ops: [], type: "x" }) };
    `);
    await expect(loadTsMath(p, { rng })).rejects.toThrow(/must be a factory function/);
  });

  test("rejects an impure module before evaluating it", async () => {
    const p = await fixture("impure.ts", `
      export default (host) => ({
        kind: "simple", name: "i", version: "1", rtp: 1,
        play: () => ({ multiplier: Math.random() < 0.5 ? 1 : 0, ops: [], type: "x" }),
      });
    `);
    await expect(loadTsMath(p, { rng })).rejects.toThrow(/not pure/);
  });

  test("rejects a factory that returns a non-math", async () => {
    const p = await fixture("nonmath.ts", `export default () => ({ kind: "banana" });`);
    await expect(loadTsMath(p, { rng })).rejects.toThrow(/expected "simple" or "complex"/);
  });

  test("stamps contentHash for the audit trail", async () => {
    const p = await fixture("h.ts", `
      export default (host) => ({
        kind: "simple", name: "h", version: "1", rtp: 1,
        play: () => ({ multiplier: 0, ops: [], type: "x" }),
      });
    `);
    const math = await loadTsMath(p, { rng });
    expect(math.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
