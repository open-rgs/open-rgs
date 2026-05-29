// M4  - priceMultiplier is client-supplied and was folded into the bet with
// no bound/integer check (could inflate the bet or make it fractional).
// M5  - spin() didn't reject a session with an open complex round.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame, RGSError,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type OpenComplex,
  type CloseComplex, type RoundReceipt, type SimpleMath, type ComplexMath,
  type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class MiniPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 100_000;
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

const simpleMath: SimpleMath = { kind: "simple", name: "s", version: "1", rtp: 1, play: () => ({ multiplier: 1, ops: [], type: "win" }) };
const complexMath: ComplexMath = {
  kind: "complex", name: "cx", version: "1", rtp: 1,
  open: () => ({ state: { o: 1 }, ops: [], awaiting: { type: "pick" } }),
  step: (state) => ({ state, ops: [] }),
  isTerminal: () => false,
  close: () => ({ multiplier: 0, ops: [], type: "close" }),
};

function setup() {
  const platform = new MiniPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 1000,
    modes: { base: { math: simpleMath, stakeMultiplier: 1 }, cx: { math: complexMath, stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}

async function spinErr(fn: () => Promise<unknown>): Promise<RGSError> {
  try { await fn(); throw new Error("expected throw"); }
  catch (e) { return e as RGSError; }
}

describe("priceMultiplier validation (M4)", () => {
  test("a fractional priceMultiplier is rejected", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "m4m5-frac" }, conn);
    const e = await spinErr(() => orch.spin({ priceMultiplier: 1.5 }, conn));
    expect(e).toBeInstanceOf(RGSError);
    expect(e.code).toBe("INVALID_BET");
  });

  test("a zero/negative/huge priceMultiplier is rejected", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "m4m5-bounds" }, conn);
    expect((await spinErr(() => orch.spin({ priceMultiplier: 0 }, conn))).code).toBe("INVALID_BET");
    expect((await spinErr(() => orch.spin({ priceMultiplier: -3 }, conn))).code).toBe("INVALID_BET");
    expect((await spinErr(() => orch.spin({ priceMultiplier: 1e9 }, conn))).code).toBe("INVALID_BET");
  });

  test("a valid integer priceMultiplier scales the bet", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "m4m5-valid" }, conn);
    const r = await orch.spin({ priceMultiplier: 2 }, conn); // bet 100 x 2 = 200
    expect(r.bet).toBe(200);
    expect(r.win).toBe(200); // multiplier 1 x 200
  });
});

describe("spin rejects an open complex round (M5)", () => {
  test("a simple spin during an open complex round is rejected", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "m4m5-open" }, conn);
    await orch.openRound({ mode: "cx" }, conn);
    const e = await spinErr(() => orch.spin({}, conn));
    expect(e).toBeInstanceOf(RGSError);
    expect(e.code).toBe("ROUND_ALREADY_OPEN");
  });
});
