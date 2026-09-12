// What a win multiplier is a multiple OF.
//
// open-rgs has always settled `win = multiplier x effectiveCost`, i.e. a
// multiple of what the round COST. That is one of the two conventions in use.
// The other - the one most published paytables are written in - is that the
// multiplier is a multiple of the BET, and the price of a feature buy has
// nothing to do with what a win pays: "max win 10000x" means 10000 times the
// bet whether you entered the feature for 1x or for 2100x.
//
// A game on the second convention that settles under the first overpays by
// the buy's price multiplier, which at 2100x is not a rounding error. It also
// writes a multiplier into round history that the game's own paytable screen
// contradicts - a max win recorded as 4.76x.
//
// `multiplierBasis` picks. Default "cost", so nothing that exists changes.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type SettleSimple, type RoundReceipt,
  type SimpleMath, type ComplexMath, type ConnectionMeta, type PlatformEvent,
  type CloseComplex, type OpenComplex,
} from "@open-rgs/contract";

const BET = 100;
const BUY_COST = 50;        // a 50x feature buy
const WIN_MULTIPLIER = 10;  // the paytable's number

/** Records what the wallet was actually told, which is half the point: the
 *  multiplier the platform stores is the one a player sees in their history. */
class MiniPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 10_000_000;
  settles: SettleSimple[] = [];
  closes: CloseComplex[] = [];
  private seq = 0;
  private openBet = 0;
  private openPrice = 1;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: this.balance, allowedBets: [BET], defaultBetIndex: 0 };
  }
  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    this.settles.push(req);
    this.balance = this.balance - req.bet * (req.priceMultiplier ?? 1) + req.win;
    return { roundId: `s${++this.seq}`, balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.openBet = req.bet;
    this.openPrice = req.priceMultiplier ?? 1;
    this.balance -= this.openBet * this.openPrice;
    return { roundId: "r1", balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    this.closes.push(req);
    this.balance += req.win;
    return { roundId: req.roundId, balance: this.balance };
  }
  onEvent(_h: (e: PlatformEvent) => void) {}
}

const payer: SimpleMath = {
  kind: "simple", name: "payer", version: "1", rtp: 1,
  play: () => ({ multiplier: WIN_MULTIPLIER, ops: [], type: "win" }),
};

const hugePayer: SimpleMath = {
  kind: "simple", name: "huge", version: "1", rtp: 1,
  play: () => ({ multiplier: 10_000, ops: [], type: "win" }),
};

const complexPayer: ComplexMath = {
  kind: "complex", name: "cpayer", version: "1", rtp: 1,
  open: () => ({ state: "{}", ops: [] }),
  step: () => ({ state: "{}", ops: [] }),
  isTerminal: () => true,
  close: () => ({ multiplier: WIN_MULTIPLIER, ops: [], type: "win" }),
};

function setup() {
  const platform = new MiniPlatform();
  const manifest = defineGame({
    id: "g", declaredRtp: 1, defaultMode: "base", maxWinMultiplier: 100_000,
    modes: {
      base:       { math: payer, stakeMultiplier: 1 },
      // The same buy, settled under each convention.
      "buy-cost": { math: payer, stakeMultiplier: BUY_COST },
      "buy-bet":  { math: payer, stakeMultiplier: BUY_COST, multiplierBasis: "bet" },
      // A cap that means "10000x the bet" rather than "10000x the stake".
      "buy-capped": { math: hugePayer, stakeMultiplier: BUY_COST, multiplierBasis: "bet", maxWinMultiplier: 5_000 },
      "complex-bet": { math: complexPayer, stakeMultiplier: BUY_COST, multiplierBasis: "bet" },
    },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, conn, platform };
}

describe("multiplierBasis", () => {
  test("the default is unchanged: a win is a multiple of what the round cost", async () => {
    const { orch, conn, platform } = setup();
    await orch.init({ sid: "mb-default" }, conn);
    const r = await orch.spin({ mode: "buy-cost" }, conn);
    // 10x on a 50x buy of a 100 bet = 10 x 5000
    expect(r.win).toBe(WIN_MULTIPLIER * BET * BUY_COST);
    expect(platform.settles[0]!.multiplier).toBe(WIN_MULTIPLIER);
  });

  test('"bet" pays a multiple of the bet, and the buy price plays no part', async () => {
    const { orch, conn, platform } = setup();
    const init = await orch.init({ sid: "mb-bet" }, conn);
    const before = init.balance;
    const r = await orch.spin({ mode: "buy-bet" }, conn);
    expect(r.win).toBe(WIN_MULTIPLIER * BET);
    // Charged the buy, paid the paytable.
    expect(r.balance).toBe(before - BET * BUY_COST + WIN_MULTIPLIER * BET);
    expect(platform.settles[0]!.multiplier).toBe(WIN_MULTIPLIER);
  });

  test("the two bases differ by exactly the buy's price", async () => {
    const { orch, conn } = setup();
    await orch.init({ sid: "mb-ratio" }, conn);
    const cost = await orch.spin({ mode: "buy-cost" }, conn);
    const bet = await orch.spin({ mode: "buy-bet" }, conn);
    expect(cost.win / bet.win).toBe(BUY_COST);
  });

  test("the platform is told the paytable's multiplier, not a rescaled one", async () => {
    // The reason this is not merely cosmetic: the multiplier the wallet
    // stores is what a player sees in their round history, and a game whose
    // screen says 10000x must not record 200x.
    const { orch, conn, platform } = setup();
    await orch.init({ sid: "mb-wire" }, conn);
    await orch.spin({ mode: "buy-bet" }, conn);
    const settle = platform.settles[0]!;
    expect(settle.multiplier).toBe(WIN_MULTIPLIER);
    // The price still reaches the wallet - as the price, on its own field.
    expect(settle.priceMultiplier).toBe(BUY_COST);
    expect(settle.bet).toBe(BET);
    expect(settle.betIndex).toBe(0);
  });

  test("the max-win cap is read in the same basis", async () => {
    const { orch, conn, platform } = setup();
    await orch.init({ sid: "mb-cap" }, conn);
    const r = await orch.spin({ mode: "buy-capped" }, conn);
    // Capped at 5000x the BET, not 5000x the stake.
    expect(r.win).toBe(5_000 * BET);
    expect(platform.settles[0]!.multiplier).toBe(5_000);
    expect(platform.settles[0]!.type).toBe("max_win_reached");
  });

  test("a complex round closes under the basis it was opened with", async () => {
    const { orch, conn, platform } = setup();
    const init = await orch.init({ sid: "mb-complex" }, conn);
    const before = init.balance;
    await orch.openRound({ mode: "complex-bet" }, conn);
    const closed = await orch.closeRound({}, conn);
    expect(closed.win).toBe(WIN_MULTIPLIER * BET);
    expect(closed.balance).toBe(before - BET * BUY_COST + WIN_MULTIPLIER * BET);
    expect(platform.closes[0]!.multiplier).toBe(WIN_MULTIPLIER);
  });

  test("the mode catalog says which basis each mode uses", async () => {
    const { orch, conn } = setup();
    const init = await orch.init({ sid: "mb-catalog" }, conn);
    const modes = init.modes as { id: string; multiplierBasis: string }[];
    // A client rendering "x{multiplier}" cannot know what the x is of
    // otherwise, and getting it wrong is how a player is told a max win
    // paid 4.76x.
    expect(modes.find((m) => m.id === "base")!.multiplierBasis).toBe("cost");
    expect(modes.find((m) => m.id === "buy-bet")!.multiplierBasis).toBe("bet");
  });
});
