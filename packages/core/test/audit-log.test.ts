// C10  - durable, append-only, tamper-evident game-outcome log.

import { describe, expect, test } from "bun:test";
import {
  createAuditLog, verifyChain, memoryAuditSink, type AuditInput,
} from "../src/audit-log.js";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type ComplexMath,
  type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

const input = (over: Partial<AuditInput> = {}): AuditInput => ({
  sessionId: "s", roundId: "r1", kind: "settle", type: "win",
  bet: 100, win: 200, multiplier: 2,
  mathName: "m", mathVersion: "1", mathContentHash: "abc", reason: "", ...over,
});

describe("audit-log hash chain (C10)", () => {
  test("records a sequenced, linked, verifiable chain", () => {
    const sink = memoryAuditSink();
    const aud = createAuditLog(sink);
    aud.record(input({ roundId: "r1" }), 1000);
    aud.record(input({ roundId: "r2", type: "loss", win: 0, multiplier: 0 }), 2000);
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(sink.events[1]!.prevHash).toBe(sink.events[0]!.hash);
    expect(verifyChain(sink.events)).toBe(-1); // intact
  });

  test("editing any recorded field breaks the chain at that event", () => {
    const sink = memoryAuditSink();
    const aud = createAuditLog(sink);
    aud.record(input({ roundId: "r1" }), 1000);
    aud.record(input({ roundId: "r2" }), 2000);
    aud.record(input({ roundId: "r3" }), 3000);
    sink.events[1]!.win = 999_999; // tamper with the credited amount
    expect(verifyChain(sink.events)).toBe(1);
  });

  test("deleting an event breaks the chain (linkage gap)", () => {
    const sink = memoryAuditSink();
    const aud = createAuditLog(sink);
    aud.record(input({ roundId: "r1" }), 1000);
    aud.record(input({ roundId: "r2" }), 2000);
    aud.record(input({ roundId: "r3" }), 3000);
    sink.events.splice(1, 1); // drop the middle event
    expect(verifyChain(sink.events)).toBe(1);
  });
});

// --- orchestrator integration -------------------------------------------
class MiniPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 10_000;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> { this.balance = this.balance - req.bet + req.win; return { roundId: `s${++this.seq}`, balance: this.balance }; }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { this.balance -= req.bet; return { roundId: `r${++this.seq}`, balance: this.balance }; }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { this.balance += req.win; return { roundId: req.roundId, balance: this.balance }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}
const simpleMath: SimpleMath = { kind: "simple", name: "slot", version: "2.0", rtp: 1, contentHash: "deadbeef", play: () => ({ multiplier: 2, ops: [], type: "win" }) };
const complexMath: ComplexMath = {
  kind: "complex", name: "mines", version: "1.0", rtp: 1, contentHash: "cafe",
  open: () => ({ state: { o: 1 }, ops: [] }), step: (s) => ({ state: s, ops: [] }),
  isTerminal: () => true, close: () => ({ multiplier: 3, ops: [], type: "win" }),
};

describe("orchestrator records audit events (C10)", () => {
  test("a simple spin records a verifiable settle event with math identity", async () => {
    const sink = memoryAuditSink();
    const platform = new MiniPlatform();
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000, modes: { base: { math: simpleMath, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform, auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "aud-1" }, conn);
    const spin = await orch.spin({ betIndex: 0 }, conn);

    expect(sink.events.length).toBe(1);
    const e = sink.events[0]!;
    expect(e.kind).toBe("settle");
    expect(e.roundId).toBe(spin.roundId);
    expect(e.bet).toBe(100);
    expect(e.win).toBe(200);
    expect(e.multiplier).toBe(2);
    expect(e.mathName).toBe("slot");
    expect(e.mathContentHash).toBe("deadbeef"); // proves which math ran
    expect(verifyChain(sink.events)).toBe(-1);
  });

  test("open then close records two linked events (open debit, close credit)", async () => {
    const sink = memoryAuditSink();
    const platform = new MiniPlatform();
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "cx", maxWinMultiplier: 1000, modes: { cx: { math: complexMath, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform, auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "aud-2" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    await orch.closeRound({}, conn);

    expect(sink.events.map((e) => e.kind)).toEqual(["open", "close"]);
    expect(sink.events[0]!.win).toBe(0);    // open is a debit
    expect(sink.events[1]!.win).toBe(300);  // close credits 3x * 100
    expect(verifyChain(sink.events)).toBe(-1);
  });
});

describe("orchestrator stamps a round-outcome status (No-Money-No-Honey taxonomy)", () => {
  test("a normal settle is stamped 'settled'", async () => {
    const sink = memoryAuditSink();
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000, modes: { base: { math: simpleMath, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform: new MiniPlatform(), auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "st-1" }, conn);
    await orch.spin({ betIndex: 0 }, conn);
    expect(sink.events[0]!.outcomeStatus).toBe("settled");
  });

  test("open is 'opened', close is 'settled'", async () => {
    const sink = memoryAuditSink();
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "cx", maxWinMultiplier: 1000, modes: { cx: { math: complexMath, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform: new MiniPlatform(), auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "st-2" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    await orch.closeRound({}, conn);
    expect(sink.events.map((e) => e.outcomeStatus)).toEqual(["opened", "settled"]);
  });

  test("a max-win-capped settle is stamped 'settled-max-win'", async () => {
    const sink = memoryAuditSink();
    // math wins 100x but the cap is 5x -> capped, type becomes max_win_reached.
    const bigWin: SimpleMath = { kind: "simple", name: "big", version: "1", rtp: 1, contentHash: "f00d", play: () => ({ multiplier: 100, ops: [], type: "win" }) };
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 5, modes: { base: { math: bigWin, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform: new MiniPlatform(), auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "st-3" }, conn);
    await orch.spin({ betIndex: 0 }, conn);
    expect(sink.events[0]!.outcomeStatus).toBe("settled-max-win");
  });

  test("a declined bet logs 'failed-bet' with win=0  - and NO 'settled' (No Money, No Honey)", async () => {
    const sink = memoryAuditSink();
    // Platform that rejects every settle (e.g. insufficient funds upstream).
    class RejectingPlatform extends MiniPlatform {
      override async settleSimple(): Promise<RoundReceipt> { throw new Error("InsufficientFunds"); }
    }
    const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000, modes: { base: { math: simpleMath, stakeMultiplier: 1 } } });
    const orch = createOrchestrator({ manifest, platform: new RejectingPlatform(), auditLog: createAuditLog(sink) });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    await orch.init({ sid: "st-4" }, conn);
    await expect(orch.spin({ betIndex: 0 }, conn)).rejects.toThrow();

    expect(sink.events.length).toBe(1);
    const e = sink.events[0]!;
    expect(e.outcomeStatus).toBe("failed-bet");
    expect(e.win).toBe(0);                         // no money credited
    expect(sink.events.some((ev) => ev.outcomeStatus === "settled")).toBe(false);
    expect(verifyChain(sink.events)).toBe(-1);     // still a valid chain
  });
});
