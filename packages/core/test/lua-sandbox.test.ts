// C6  - the math VM is a trust boundary. Overriding require() left os, io,
// debug, load, loadfile, package, collectgarbage and a bypass-the-RNG
// math.random all reachable. These tests load a probe math under the
// sandbox and assert the dangerous surface is gone and math.random is
// routed through the injected host RNG.

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLuaMath } from "../src/lua-math.js";
import type { SimpleMath } from "@open-rgs/contract";

const here = fileURLToPath(new URL(".", import.meta.url));
const PROBE = resolve(here, "fixtures/sandbox-probe.lua");

async function runProbe(rngValue: number): Promise<string> {
  const m = (await loadLuaMath(PROBE, { rng: () => rngValue })) as SimpleMath;
  const out = await m.play(undefined, { mode: "default" });
  return out.carry as string;
}

describe("Lua VM sandbox (C6)", () => {
  test("os / io / debug / load / loadfile / package / collectgarbage are all nil", async () => {
    const report = await runProbe(0.5);
    const [leaked] = report.split("|");
    expect(leaked).toBe(""); // no dangerous global reachable
  });

  test("math.random() is routed through the injected host RNG", async () => {
    // math.random() with no args returns host.rng_next() verbatim.
    const report = await runProbe(0.5);
    expect(report.endsWith("|rand=0.5")).toBe(true);

    const report2 = await runProbe(0.25);
    expect(report2.endsWith("|rand=0.25")).toBe(true);
  });

  test("the fixture itself still runs (sandbox doesn't break legitimate math)", async () => {
    const m = (await loadLuaMath(PROBE, { rng: () => 0.1 })) as SimpleMath;
    const out = await m.play(undefined, { mode: "default" });
    expect(out.type).toBe("probe");
  });
});
