// M9  - updateComplex was the only server-side action log yet was
// fire-and-forget with swallowed failures. A mandatory mode now blocks and
// fails the step if the action-log write is dropped. Step actions are also
// recorded into the tamper-evident audit log.

import { describe, expect, test } from "bun:test";
import { createOrchestrator, createAuditLog, memoryAuditSink, verifyChain } from "../src/index.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type OpenComplex, type UpdateComplex,
  type CloseComplex, type RoundReceipt, type ComplexMath, type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class UpdatePlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  failUpdate = false;
  updates = 0;
  private seq = 0;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: 10_000, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(): Promise<RoundReceipt> { return { roundId: "s", balance: 10_000 }; }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> { return { roundId: `r${++this.seq}`, balance: 10_000 - req.bet }; }
  async updateComplex(_req: UpdateComplex): Promise<void> { this.updates++; if (this.failUpdate) throw new Error("audit sink down"); }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> { return { roundId: req.roundId, balance: 10_000 }; }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const complexMath: ComplexMath = {
  kind: "complex", name: "cx", version: "1", rtp: 1, contentHash: "h",
  open: () => ({ state: { picks: 0 }, ops: [], awaiting: { type: "pick" } }),
  step: (s) => ({ state: s, ops: [], awaiting: { type: "pick" } }),
  isTerminal: () => false,
  close: () => ({ multiplier: 0, ops: [], type: "close" }),
};

function setup(auditMode: "best-effort" | "mandatory", sink = memoryAuditSink()) {
  const platform = new UpdatePlatform();
  const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "cx", modes: { cx: { math: complexMath, stakeMultiplier: 1 } } });
  const orch = createOrchestrator({ manifest, platform, auditMode, auditLog: createAuditLog(sink) });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn, sink };
}

describe("mandatory audit mode (M9)", () => {
  test("best-effort: a dropped updateComplex does NOT fail the step", async () => {
    const { orch, platform, conn } = setup("best-effort");
    await orch.init({ sid: "m9-be" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    platform.failUpdate = true;
    const r = await orch.stepRound({ action: { type: "pick" } }, conn); // resolves despite update failure
    expect(r).toBeDefined();
  });

  test("mandatory: a dropped updateComplex FAILS the step", async () => {
    const { orch, platform, conn } = setup("mandatory");
    await orch.init({ sid: "m9-mand" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    platform.failUpdate = true;
    let err: unknown;
    try { await orch.stepRound({ action: { type: "pick" } }, conn); }
    catch (e) { err = e; }
    expect(err).toBeInstanceOf(RGSError);
    expect((err as RGSError).code).toBe("STEP_FAILED");
  });

  test("step actions are recorded into the audit chain", async () => {
    const sink = memoryAuditSink();
    const { orch, conn } = setup("best-effort", sink);
    await orch.init({ sid: "m9-log" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    await orch.stepRound({ action: { type: "pick" } }, conn);
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds).toContain("open");
    expect(kinds).toContain("step");
    expect(sink.events.find((e) => e.kind === "step")!.type).toBe("pick");
    expect(verifyChain(sink.events)).toBe(-1);
  });
});
