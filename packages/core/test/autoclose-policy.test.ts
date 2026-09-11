// H5  - the game-declared AutoclosePolicy was ignored, and a round with
// banked value could be silently forfeited (settle multiplier 0) when the
// math defined no autoclose(). These tests pin that the policy is honoured.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type OpenComplex, type CloseComplex,
  type RoundReceipt, type ComplexMath, type ConnectionMeta, type PlatformEvent,
  type GameManifest, type AutoclosePolicy,
} from "@open-rgs/contract";

class SpyPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  closeWins: number[] = [];
  balance = 10_000;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(): Promise<RoundReceipt> { return { roundId: "s", balance: this.balance }; }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r${++this.seq}`, balance: this.balance }; }
  closeReasons: (string | undefined)[] = [];
  closeCarries: (string | undefined)[] = [];
  closeMathVersions: (string | undefined)[] = [];
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.closeWins.push(req.win); this.closeReasons.push(req.reason); this.closeCarries.push(req.carry); this.closeMathVersions.push(req.mathVersion); this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

// Complex math: optionally implements autoclose() returning a banked value.
function complexMath(withAutoclose: boolean): ComplexMath {
  return {
    kind: "complex", name: "cx", version: "1", rtp: 1,
    open: () => ({ state: { open: true }, ops: [], awaiting: { type: "pick" } }), // NON-terminal
    step: (state) => ({ state, ops: [] }),
    isTerminal: () => false,
    close: () => ({ multiplier: 0, ops: [], type: "close" }),
    ...(withAutoclose ? { autoclose: () => ({ multiplier: 5, ops: [], type: "autoclose-banked", carry: "carry-from-autoclose" }) } : {}),
  };
}

function setup(policy: AutoclosePolicy["policy"], withAutoclose: boolean) {
  const platform = new SpyPlatform();
  const manifest: GameManifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "cx", maxWinMultiplier: 1000,
    autoclose: { idleMs: 1000, policy },
    modes: { cx: { math: complexMath(withAutoclose), stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}

describe("autoclose policy (H5)", () => {
  test("settle-at-current with a math valuation pays the banked value (not forfeited)", async () => {
    const { orch, platform, conn } = setup("settle-at-current", true);
    await orch.init({ sid: "s1" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    const res = await orch.autocloseRound({ sessionId: "s1", roundId: opened.roundId, reason: "idle" });
    expect(res.closed).toBe(true);
    expect(platform.closeWins).toEqual([500]); // multiplier 5 x bet 100, NOT 0
  });

  test("settle-at-current with NO valuation refuses (round not silently forfeited)", async () => {
    const { orch, platform, conn } = setup("settle-at-current", false);
    await orch.init({ sid: "s2" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    const res = await orch.autocloseRound({ sessionId: "s2", roundId: opened.roundId, reason: "idle" });
    expect(res.closed).toBe(false);
    expect(res.reason).toMatch(/settle-at-current/);
    expect(platform.closeWins).toEqual([]); // no settle happened  - value preserved
  });

  test("settle-as-loss forfeits even when the math could value it", async () => {
    const { orch, platform, conn } = setup("settle-as-loss", true);
    await orch.init({ sid: "s3" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    await orch.autocloseRound({ sessionId: "s3", roundId: opened.roundId, reason: "idle" });
    expect(platform.closeWins).toEqual([0]); // explicit operator forfeit
  });

  test("hold does not autoclose  - the round persists", async () => {
    const { orch, platform, conn } = setup("hold", true);
    await orch.init({ sid: "s4" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    const res = await orch.autocloseRound({ sessionId: "s4", roundId: opened.roundId, reason: "idle" });
    expect(res.closed).toBe(false);
    expect(res.reason).toBe("policy-hold");
    expect(platform.closeWins).toEqual([]);
    // round still open  - a later close is still possible
    const res2 = await orch.autocloseRound({ sessionId: "s4", roundId: opened.roundId, reason: "again" });
    expect(res2.closed).toBe(false);
  });

  test("math-decides uses the math valuation when present", async () => {
    const { orch, platform, conn } = setup("math-decides", true);
    await orch.init({ sid: "s5" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    await orch.autocloseRound({ sessionId: "s5", roundId: opened.roundId, reason: "idle" });
    expect(platform.closeWins).toEqual([500]);
  });

  test("autoclose forwards the trigger reason to the wallet for audit (M1)", async () => {
    const { orch, platform, conn } = setup("math-decides", true);
    await orch.init({ sid: "s6" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    await orch.autocloseRound({ sessionId: "s6", roundId: opened.roundId, reason: "session-closed: kicked" });
    expect(platform.closeReasons).toEqual(["session-closed: kicked"]);
  });

  test("autoclose writes the math's carry to the WALLET, not just to memory", async () => {
    // The wallet is the source of truth for carry: it is what the next
    // openSession reads. An autoclose that updated only the in-memory session
    // looked correct for as long as that process kept the session, and reset
    // every meter the round had advanced the moment anyone reconnected.
    const { orch, platform, conn } = setup("math-decides", true);
    await orch.init({ sid: "s7" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    await orch.autocloseRound({ sessionId: "s7", roundId: opened.roundId, reason: "idle" });
    expect(platform.closeCarries).toEqual(["carry-from-autoclose"]);
    // Stamped with the math that produced it, the same as a client close, so
    // the RGS can tell a carry written by older math from one it can use.
    expect(platform.closeMathVersions).toEqual(["1"]);
  });
});
