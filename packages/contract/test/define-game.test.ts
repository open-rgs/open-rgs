// M3 — defineGame validation. Bad manifests previously passed and failed at
// runtime; now they're rejected at boot. (Contract shipped no tests — M12.)

import { describe, expect, test } from "bun:test";
import { defineGame, type GameManifest, type SimpleMath } from "../src/index.js";

const math: SimpleMath = { kind: "simple", name: "m", version: "1", rtp: 1, play: () => ({ multiplier: 0, ops: [], type: "x" }) };
const base = (over: Partial<GameManifest> = {}): GameManifest => ({
  id: "g", declaredRtp: 0.96, defaultMode: "base",
  modes: { base: { math, stakeMultiplier: 1 } },
  ...over,
}) as GameManifest;

describe("defineGame validation (M3)", () => {
  test("a valid manifest passes and is frozen (deeply)", () => {
    const m = defineGame(base());
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.modes)).toBe(true);
    expect(Object.isFrozen(m.modes["base"])).toBe(true); // nested mode frozen too
  });

  test("rejects empty modes", () => {
    expect(() => defineGame({ id: "g", declaredRtp: 0.9, defaultMode: "x", modes: {} } as GameManifest)).toThrow(/non-empty/);
  });

  test("rejects a defaultMode not present in modes", () => {
    expect(() => defineGame(base({ defaultMode: "nope" }))).toThrow(/defaultMode/);
  });

  test("rejects an internal defaultMode", () => {
    const m = base({
      defaultMode: "fs",
      modes: { fs: { math, stakeMultiplier: 0, internal: true } },
    } as Partial<GameManifest>);
    expect(() => defineGame(m)).toThrow(/internal/);
  });

  test("rejects declaredRtp outside [0,1] or non-finite", () => {
    expect(() => defineGame(base({ declaredRtp: 1.5 }))).toThrow(/declaredRtp/);
    expect(() => defineGame(base({ declaredRtp: -0.1 }))).toThrow(/declaredRtp/);
    expect(() => defineGame(base({ declaredRtp: NaN }))).toThrow(/declaredRtp/);
  });

  test("rejects non-positive maxWinMultiplier", () => {
    expect(() => defineGame(base({ maxWinMultiplier: 0 }))).toThrow(/maxWinMultiplier/);
    expect(() => defineGame(base({ maxWinMultiplier: -5 }))).toThrow(/maxWinMultiplier/);
  });

  test("rejects a mode with no math or a bad kind", () => {
    expect(() => defineGame(base({ modes: { base: { stakeMultiplier: 1 } } } as unknown as Partial<GameManifest>))).toThrow(/math/);
    expect(() => defineGame(base({ modes: { base: { math: { kind: "weird" }, stakeMultiplier: 1 } } } as unknown as Partial<GameManifest>))).toThrow(/math/);
  });

  test("allows a per-mode declaredRtp > 1 (bonus mode funded by base)", () => {
    const m = base({ modes: { base: { math, stakeMultiplier: 1, declaredRtp: 2.5 } } } as Partial<GameManifest>);
    expect(() => defineGame(m)).not.toThrow();
  });

  test("rejects a negative per-mode declaredRtp", () => {
    const m = base({ modes: { base: { math, stakeMultiplier: 1, declaredRtp: -1 } } } as Partial<GameManifest>);
    expect(() => defineGame(m)).toThrow(/declaredRtp/);
  });
});
