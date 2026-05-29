// L1  - an abandoned spin (beginSpin without endSpin) used to silently drop
// its tags and skip the spin count, skewing tag-share stats. It's now
// finalized when the next beginSpin arrives.

import { describe, expect, test } from "bun:test";
import { createMarkCollector } from "../src/marks.js";

describe("createMarkCollector abandoned-spin handling (L1)", () => {
  test("a beginSpin with a prior spin still open counts the abandoned spin", () => {
    const m = createMarkCollector();
    m.beginSpin();
    m.tag("a");
    m.beginSpin();   // spin 1 never ended  - must be finalized, not dropped
    m.tag("b");
    m.endSpin();     // spin 2
    const snap = m.snapshot();
    expect(snap.spinsCompleted).toBe(2);
    expect(snap.tagSpins["a"]).toBe(1); // abandoned spin's tag still counted
    expect(snap.tagSpins["b"]).toBe(1);
  });

  test("endSpin without a beginSpin doesn't count a phantom spin", () => {
    const m = createMarkCollector();
    m.endSpin();
    expect(m.snapshot().spinsCompleted).toBe(0);
  });

  test("normal begin/end pairs count one spin each", () => {
    const m = createMarkCollector();
    m.beginSpin(); m.tag("x"); m.endSpin();
    m.beginSpin(); m.endSpin();
    const snap = m.snapshot();
    expect(snap.spinsCompleted).toBe(2);
    expect(snap.tagSpins["x"]).toBe(1);
  });
});
