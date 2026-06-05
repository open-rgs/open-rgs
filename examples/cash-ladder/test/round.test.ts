// CI gate for the cash-ladder complex Zig example: a full open -> step -> close
// lifecycle through loadWasmMath, plus the bust path.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadWasmMath } from "../../../packages/core/src/index.js";
import type { ComplexMath } from "../../../packages/contract/src/index.js";

const WASM = resolve(import.meta.dir, "../maths/play.wasm");
const ctx = { mode: "default" } as const;

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
