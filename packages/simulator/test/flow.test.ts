// Play-flow graph: aggregates how complex rounds were played into a Markov
// chain, attached to report.flow and rendered by mdReport.

import { describe, expect, test } from "bun:test";
import { simulate, createFlowRecorder, flowToMermaid, flowToMarkovTable } from "../src/index.js";
import { defineGame, type ComplexMath, type GameManifest } from "@open-rgs/contract";

// Two-decision game: open -> step -> step -> close. Deterministic so we can
// assert exact structure.
function twoStep(): ComplexMath {
  return {
    kind: "complex", name: "two", version: "1.0.0", rtp: 0,
    open: () => ({ state: "0", ops: [], awaiting: { type: "go", options: ["a", "b"] } }),
    step: (state) => {
      const k = Number(state) + 1;
      return { state: String(k), ops: [], awaiting: k >= 2 ? undefined : { type: "go", options: ["a", "b"] } };
    },
    isTerminal: (state) => Number(state) >= 2,
    close: () => ({ multiplier: 0, ops: [], type: "done" }),
  };
}
const game = (m: ComplexMath): GameManifest =>
  defineGame({ id: "two", declaredRtp: 0, defaultMode: "default", modes: { default: { math: m, stakeMultiplier: 1 } } });

describe("play-flow graph", () => {
  test("createFlowRecorder aggregates a path into counted edges", () => {
    const rec = createFlowRecorder();
    rec.round([{ label: "A", action: "hit" }, { label: "B", action: "stand" }], "win");
    rec.round([{ label: "A", action: "hit" }, { label: "B", action: "stand" }], "win");
    const g = rec.graph();
    expect(g.rounds).toBe(2);
    expect(g.edges.find((e) => e.from === "A" && e.to === "B")?.count).toBe(2);
    expect(g.edges.some((e) => e.from === "▶ start")).toBe(true);
    expect(g.edges.some((e) => e.to === "■ win")).toBe(true);
  });

  test("simulate({ flow: true }) attaches a graph and renders mermaid + table", async () => {
    const [rep] = await simulate(game(twoStep()), { spinsPerMode: 50, flow: true });
    expect(rep!.flow).toBeDefined();
    expect(rep!.flow!.rounds).toBe(50);
    expect(rep!.flow!.edges.length).toBeGreaterThan(0);
    expect(flowToMermaid(rep!.flow!).startsWith("flowchart")).toBe(true);
    expect(flowToMarkovTable(rep!.flow!)).toContain("| from |");
  });

  test("a custom label buckets nodes from the public context", async () => {
    const [rep] = await simulate(game(twoStep()), { spinsPerMode: 20, flow: { label: ({ step }) => `step${step}` } });
    expect(rep!.flow!.edges.some((e) => e.from === "step0")).toBe(true);
    expect(rep!.flow!.edges.some((e) => e.from === "step1")).toBe(true);
  });

  test("flow is off by default (no overhead, no graph)", async () => {
    const [rep] = await simulate(game(twoStep()), { spinsPerMode: 10 });
    expect(rep!.flow).toBeUndefined();
  });
});
