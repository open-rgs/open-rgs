// C2 — the max-win cap is the only validation between untrusted math
// output and a settle call, so it must fail closed. These tests pin the
// dangerous cases the audit reproduced:
//   - NaN / Infinity multiplier must NOT become a maximum payout
//   - a negative multiplier must NOT become a negative settlement
//   - a finite, in-cap multiplier is returned unchanged
//   - a finite, over-cap multiplier is clipped (existing behaviour)

import { describe, expect, test } from "bun:test";
import { applyMaxWinCap, applyMaxWinCapClose } from "../src/orchestrator.js";
import { RGSError, type RoundOutcome, type CloseOutcome } from "@open-rgs/contract";

function outcome(multiplier: number): RoundOutcome {
  return { multiplier, ops: [{ kind: "spin" }], type: "win" };
}
function closeOutcome(multiplier: number): CloseOutcome {
  return { multiplier, ops: [{ kind: "close" }], type: "win" };
}

describe("applyMaxWinCap — fail-closed multiplier validation (C2)", () => {
  test("NaN multiplier throws instead of paying the cap", () => {
    expect(() => applyMaxWinCap(outcome(NaN), 100, 5000)).toThrow(RGSError);
    expect(() => applyMaxWinCap(outcome(NaN), 100, 5000)).toThrow(/non-finite/);
  });

  test("Infinity multiplier throws instead of paying the cap", () => {
    expect(() => applyMaxWinCap(outcome(Infinity), 100, 5000)).toThrow(RGSError);
    expect(() => applyMaxWinCap(outcome(-Infinity), 100, 5000)).toThrow(RGSError);
  });

  test("non-finite throws even when no cap is configured", () => {
    expect(() => applyMaxWinCap(outcome(NaN), 100, undefined)).toThrow(RGSError);
  });

  test("negative multiplier is clamped to 0 (a loss), never a negative settle", () => {
    const r = applyMaxWinCap(outcome(-5), 100, 5000);
    expect(r.multiplier).toBe(0);
    // win = multiplier * bet would be 0, not -500
  });

  test("in-cap multiplier is returned unchanged (same object)", () => {
    const o = outcome(3);
    expect(applyMaxWinCap(o, 100, 5000)).toBe(o);
  });

  test("over-cap multiplier is clipped and stamped max_win_reached", () => {
    const r = applyMaxWinCap(outcome(9000), 100, 5000);
    expect(r.multiplier).toBe(5000);
    expect(r.type).toBe("max_win_reached");
    expect(r.ops.at(-1)).toMatchObject({ kind: "max_win", cap_multiplier: 5000, raw_multiplier: 9000 });
  });

  test("zero multiplier (clean loss) passes through unchanged", () => {
    const o = outcome(0);
    expect(applyMaxWinCap(o, 100, 5000)).toBe(o);
  });
});

describe("applyMaxWinCapClose — same guard for complex rounds (C2)", () => {
  test("NaN multiplier throws", () => {
    expect(() => applyMaxWinCapClose(closeOutcome(NaN), 100, 5000)).toThrow(RGSError);
  });

  test("Infinity multiplier throws", () => {
    expect(() => applyMaxWinCapClose(closeOutcome(Infinity), 100, 5000)).toThrow(RGSError);
  });

  test("negative multiplier clamps to 0", () => {
    expect(applyMaxWinCapClose(closeOutcome(-1), 100, 5000).multiplier).toBe(0);
  });

  test("over-cap multiplier is clipped", () => {
    expect(applyMaxWinCapClose(closeOutcome(1e9), 100, 5000).multiplier).toBe(5000);
  });
});
