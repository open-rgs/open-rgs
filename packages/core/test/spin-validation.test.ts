// M4 — priceMultiplier is client-supplied and was folded into the bet with
// no bound/integer check (could inflate the bet or make it fractional).
// M5 — spin() didn't reject a session with an open complex round.

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
    const r = await orch.spin({ priceMultiplier: 2 }, conn); // bet 100 × 2 = 200
    expect(r.bet).toBe(200);
    expect(r.win).toBe(200); // multiplier 1 × 200
  });
});

describe("fractional stakeMultiplier — stake rides on priceMultiplier, not bet", () => {
  // The orchestrator used to compute `bet = base × priceMul × stakeMul`.
  // For a fractional stake like ante 1.25× on a 1-unit base, that produced
  // bet = 1.25 which failed the integer-minor-units assertion (audit H1)
  // and made spin() throw INVALID_BET. The fix: stake stays out of bet,
  // rides on priceMultiplier instead. Bet stays integer; platform sees
  // bet (integer) + priceMultiplier (with stake fold) and computes its
  // own debit at currency precision.

  class CostTrackingPlatform implements PlatformAdapter {
    isHealthy = true;
    diagnostics = {};
    balance = 100_000;
    lastBet: number | null = null;
    lastPriceMultiplier: number | null = null;
    private seq = 0;
    async connect() {}
    disconnect() {}
    async openSession(sessionId: string): Promise<SessionInfo> {
      return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
      this.lastBet = req.bet;
      this.lastPriceMultiplier = req.priceMultiplier ?? 1;
      const cost = req.bet * (req.priceMultiplier ?? 1);
      this.balance = this.balance - cost + req.win;
      return { roundId: `s${++this.seq}`, balance: this.balance };
    }
    async openComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
    async closeComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: this.balance }; }
    onEvent(_h: (e: PlatformEvent) => void) {}
  }

  const tenX: SimpleMath = { kind: "simple", name: "10x", version: "1", rtp: 1, play: () => ({ multiplier: 10, ops: [], type: "win" }) };

  function setupFracStake() {
    const platform = new CostTrackingPlatform();
    const manifest = defineGame({
      id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 5000,
      modes: {
        base:  { math: tenX, stakeMultiplier: 1 },
        ante:  { math: tenX, stakeMultiplier: 1.25 },  // fractional — the failing case
        buy:   { math: tenX, stakeMultiplier: 59 },    // integer-but-large buy mode
      },
    });
    const orch = createOrchestrator({ manifest, platform });
    const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
    return { orch, platform, conn };
  }

  test("ante (1.25 stake) on a 100-base bet no longer throws INVALID_BET", async () => {
    const { orch, platform, conn } = setupFracStake();
    await orch.init({ sid: "frac-ante" }, conn);
    const r = await orch.spin({ mode: "ante" }, conn);

    // Wire `bet` is the integer base × priceMul (= 100 × 1).
    expect(r.bet).toBe(100);
    // win = 10 (mult) × 125 (effectiveCost = bet × stake = 100 × 1.25) = 1250.
    expect(r.win).toBe(1250);
    // Platform sees bet=100, priceMultiplier=1.25 (priceMul × stake).
    expect(platform.lastBet).toBe(100);
    expect(platform.lastPriceMultiplier).toBe(1.25);
    // Balance: -125 (cost) + 1250 (win) = +1125 from starting 100_000.
    expect(r.balance).toBe(101_125);
  });

  test("buy mode (stake 59) debits 59× and computes win against the stake-adjusted bet", async () => {
    const { orch, platform, conn } = setupFracStake();
    await orch.init({ sid: "frac-buy" }, conn);
    const r = await orch.spin({ mode: "buy" }, conn);

    expect(r.bet).toBe(100);                  // base × priceMul (no stake)
    expect(platform.lastBet).toBe(100);       // wire bet stays integer
    expect(platform.lastPriceMultiplier).toBe(59);  // stake on priceMul
    expect(r.win).toBe(59_000);               // 10 × (100 × 59)
    expect(r.balance).toBe(100_000 - 5_900 + 59_000);
  });

  test("explicit priceMultiplier from the client composes with stake", async () => {
    const { orch, platform, conn } = setupFracStake();
    await orch.init({ sid: "frac-compose" }, conn);
    // Client sends priceMultiplier=3 on an ante (stake 1.25) — total
    // priceMul × stake = 3.75. bet = base × 3 = 300 (integer).
    const r = await orch.spin({ mode: "ante", priceMultiplier: 3 }, conn);
    expect(r.bet).toBe(300);
    expect(platform.lastBet).toBe(300);
    expect(platform.lastPriceMultiplier).toBe(3.75);
    // win = 10 × (300 × 1.25) = 3750.
    expect(r.win).toBe(3750);
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
