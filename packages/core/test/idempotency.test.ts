// C3 — idempotency keys must be STABLE across retries so the wallet can
// dedupe a retried money op to one movement. The old code minted a fresh
// UUID per call, so retries could never be recognised. These tests pin:
//   - the deterministic derivation is pure/stable
//   - a complex close keys on (sessionId, roundId) — so a client CLOSE and
//     an autoclose of the same round produce the IDENTICAL key
//   - a simple spin with a client token derives deterministically (and is
//     stable across resends); without a token it falls back to a random key

import { describe, expect, test } from "bun:test";
import { createOrchestrator, deriveIdempotencyKey } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple,
  type OpenComplex, type CloseComplex, type RoundReceipt,
  type SimpleMath, type ComplexMath, type ConnectionMeta,
  type PlatformEvent,
} from "@open-rgs/contract";

// Records every idempotency key the orchestrator sends.
class SpyPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  settleKeys: string[] = [];
  closeKeys: string[] = [];
  private seq = 0;
  private balance = 10_000;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId, currency: "USD", currencyDecimals: 2,
      balance: this.balance, allowedBets: [10, 100], defaultBetIndex: 1,
    };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.settleKeys.push(req.idempotencyKey ?? "<none>");
    this.balance = this.balance - req.bet + req.win;
    return { roundId: `r${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.balance -= req.bet;
    return { roundId: `r${++this.seq}`, balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    this.closeKeys.push(req.idempotencyKey ?? "<none>");
    this.balance += req.win;
    return { roundId: req.roundId, balance: this.balance };
  }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const simpleMath: SimpleMath = {
  kind: "simple", name: "s", version: "1", rtp: 1,
  play: () => ({ multiplier: 2, ops: [], type: "win" }),
};
const complexMath: ComplexMath = {
  kind: "complex", name: "cx", version: "1", rtp: 1,
  open: () => ({ state: { open: true }, ops: [] }),
  step: (state) => ({ state, ops: [] }),
  isTerminal: () => true,
  close: () => ({ multiplier: 2, ops: [], type: "win" }),
};

function makeOrchestrator() {
  const platform = new SpyPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: {
      base: { math: simpleMath, stakeMultiplier: 1 },
      cx: { math: complexMath, stakeMultiplier: 1 },
    },
  });
  const orch = createOrchestrator({ manifest, platform, isDev: false });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}

describe("deriveIdempotencyKey (C3)", () => {
  test("is deterministic and order-sensitive", () => {
    expect(deriveIdempotencyKey("s", "r", "close")).toBe("s:r:close");
    expect(deriveIdempotencyKey("s", "r", "close")).toBe(deriveIdempotencyKey("s", "r", "close"));
    expect(deriveIdempotencyKey("s", "r1")).not.toBe(deriveIdempotencyKey("s", "r2"));
  });
});

describe("orchestrator close keys (C3 / C4 race)", () => {
  test("client close keys on (sessionId, roundId)", async () => {
    const { orch, platform, conn } = makeOrchestrator();
    await orch.init({ sid: "sess1" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    await orch.closeRound({}, conn);
    expect(platform.closeKeys).toEqual([deriveIdempotencyKey("sess1", opened.roundId, "close")]);
  });

  test("autoclose of a round derives the IDENTICAL key as a client close", async () => {
    const { orch, platform, conn } = makeOrchestrator();
    await orch.init({ sid: "sess1" }, conn);
    const opened = await orch.openRound({ mode: "cx" }, conn);
    const expectedKey = deriveIdempotencyKey("sess1", opened.roundId, "close");
    await orch.autocloseRound({ sessionId: "sess1", roundId: opened.roundId, reason: "test" });
    // Same formula, same roundId → a real close racing this autoclose would
    // send the identical key, so the wallet collapses them to one credit.
    expect(platform.closeKeys).toEqual([expectedKey]);
  });
});

describe("orchestrator spin keys (C3)", () => {
  test("client token → deterministic, stable across resends", async () => {
    const { orch, platform, conn } = makeOrchestrator();
    await orch.init({ sid: "sess1" }, conn);
    await orch.spin({ idempotencyKey: "tok-A" }, conn);
    await orch.spin({ idempotencyKey: "tok-A" }, conn);
    expect(platform.settleKeys).toEqual([
      "sess1:spin:tok-A",
      "sess1:spin:tok-A",
    ]);
  });

  test("no client token → random fallback, distinct per call", async () => {
    const { orch, platform, conn } = makeOrchestrator();
    await orch.init({ sid: "sess1" }, conn);
    await orch.spin({}, conn);
    await orch.spin({}, conn);
    expect(platform.settleKeys[0]).not.toBe(platform.settleKeys[1]);
    expect(platform.settleKeys[0]).not.toContain("spin:");
  });
});
