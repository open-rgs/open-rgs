// Complex WASM math: loadWasmMath driving an open/step/close kernel. The point
// is that the host threads the kernel's opaque serialized state across calls
// (as a base64 RoundState string), and the lifecycle - awaiting hints, terminal
// detection, cashout vs bust - round-trips through MessagePack.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadWasmMath } from "../src/wasm-math.js";
import type { ComplexMath, SpinContext } from "@open-rgs/contract";

const COMPLEX = resolve(import.meta.dir, "fixtures/wasm/complex.wasm"); // cash-ladder
const ctx: SpinContext = { mode: "default" };

// Fixed RNG so the round is deterministic. P_BUST = 0.25 in the kernel:
const NEVER_BUST = () => 0.99; // draw >= 0.25 -> climb
const ALWAYS_BUST = () => 0.01; // draw <  0.25 -> bust

describe("loadWasmMath (complex: open/step/is_terminal/close)", () => {
  test("loads as complex math with the right metadata", async () => {
    const m = (await loadWasmMath(COMPLEX, { rng: NEVER_BUST })) as ComplexMath;
    expect(m.kind).toBe("complex");
    expect(m.name).toBe("wasm-ladder");
    expect(typeof m.open).toBe("function");
    expect(typeof m.step).toBe("function");
    expect(typeof m.isTerminal).toBe("function");
    expect(typeof m.close).toBe("function");
    expect(typeof m.autoclose).toBe("function");
  });

  test("threads serialized state across open -> step* -> close; cashout pays", async () => {
    const m = (await loadWasmMath(COMPLEX, { rng: NEVER_BUST })) as ComplexMath;

    const o = await m.open(undefined, ctx);
    expect(typeof o.state).toBe("string"); // opaque base64 RoundState
    expect(o.state.length).toBeGreaterThan(0);
    expect(o.awaiting?.type).toBe("climb");

    // Three climbs (never busts at rng=0.99). State must thread through.
    let state = o.state;
    let mult = 1;
    for (let k = 0; k < 3; k++) {
      const s = await m.step(state, { type: "climb" });
      expect(typeof s.state).toBe("string");
      expect(s.state).not.toBe(state); // state advanced
      expect(s.awaiting?.type).toBe("climb"); // not terminal yet
      state = s.state;
    }
    expect(await m.isTerminal(state)).toBe(false);

    const c = await m.close(state);
    expect(c.type).toBe("cashout");
    expect(c.multiplier).toBeGreaterThan(mult); // climbed -> > 1x
    mult = c.multiplier;
    // 1.28^3 ~= 2.097
    expect(c.multiplier).toBeGreaterThan(2);
    expect(c.multiplier).toBeLessThan(2.2);
  });

  test("a bust is terminal (awaiting cleared) and pays 0", async () => {
    const m = (await loadWasmMath(COMPLEX, { rng: ALWAYS_BUST })) as ComplexMath;
    const o = await m.open(undefined, ctx);
    const s = await m.step(o.state, { type: "climb" });
    expect(s.awaiting).toBeUndefined(); // terminal -> ready to close
    expect(await m.isTerminal(s.state)).toBe(true);

    const c = await m.close(s.state);
    expect(c.type).toBe("bust");
    expect(c.multiplier).toBe(0);
  });

  test("same state + same rng => identical outcome (deterministic, no hidden state)", async () => {
    const a = (await loadWasmMath(COMPLEX, { rng: () => 0.5 })) as ComplexMath;
    const b = (await loadWasmMath(COMPLEX, { rng: () => 0.5 })) as ComplexMath;

    const oa = await a.open(undefined, ctx);
    const ob = await b.open(undefined, ctx);
    expect(oa.state).toBe(ob.state); // open draws no rng -> identical

    const sa = await a.step(oa.state, { type: "climb" });
    const sb = await b.step(ob.state, { type: "climb" });
    expect(sa.state).toBe(sb.state); // same state in + same draw -> same state out
  });

  test("autoclose resolves from current state like close", async () => {
    const m = (await loadWasmMath(COMPLEX, { rng: NEVER_BUST })) as ComplexMath;
    const o = await m.open(undefined, ctx);
    const s = await m.step(o.state, { type: "climb" });
    const c = await m.autoclose!(s.state);
    expect(c.type).toBe("cashout");
    expect(c.multiplier).toBeGreaterThan(1);
  });
});
