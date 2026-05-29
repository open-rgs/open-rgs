// M6  - abandoned open rounds accumulate forever (no TTL), an operational
// blind spot. openRoundStats makes debited-but-unclosed rounds observable
// (surfaced in /healthz). Assertions are relative (the session map is a
// module global shared across test files) so they're robust to other tests.

import { describe, expect, test } from "bun:test";
import { put, remove, openRoundStats, type LocalSession } from "../src/session.js";

function openSession(id: string, openedAt: number): LocalSession {
  return {
    sessionId: id, connectionId: "c", balance: 0,
    currency: "USD", currencyDecimals: 2, allowedBets: [100], defaultBetIndex: 0,
    createdAt: openedAt,
    openRound: { roundId: "r", modeId: "m", bet: 100, state: {}, actionLog: [], opsLog: [], openedAt },
  } as unknown as LocalSession;
}

describe("open-round observability (M6)", () => {
  test("openRoundStats counts open rounds and reports the oldest age", () => {
    const now = 5_000_000;
    const before = openRoundStats(now);
    put(openSession("m6-open-a", now - 8_000));
    const after = openRoundStats(now);
    expect(after.open_rounds).toBe(before.open_rounds + 1);
    expect(after.oldest_open_round_age_ms).toBeGreaterThanOrEqual(8_000);
    remove("m6-open-a");
    expect(openRoundStats(now).open_rounds).toBe(before.open_rounds);
  });

  test("a session with no open round is not counted", () => {
    const now = 5_000_000;
    const before = openRoundStats(now);
    put({
      sessionId: "m6-idle", connectionId: "c", balance: 0,
      currency: "USD", currencyDecimals: 2, allowedBets: [100], defaultBetIndex: 0,
      createdAt: now,
    } as unknown as LocalSession);
    expect(openRoundStats(now).open_rounds).toBe(before.open_rounds);
    remove("m6-idle");
  });
});
