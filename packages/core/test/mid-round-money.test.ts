// Mid-round money: a step that takes a stake or pays an award without closing
// the round.
//
// The cases that matter are the refusals. A game whose math asks for money the
// adapter cannot move must fail the step, not carry on; a mid-round stake must
// raise what the round has cost so the max-win cap scales with it; and a
// mid-round award must spend the cap it uses, so a round cannot pay its
// ceiling once per step and again at close.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame,
  type AwardComplex,
  type ComplexMath,
  type ConnectionMeta,
  type CloseComplex,
  type OpenComplex,
  type PlatformAdapter,
  type PlatformEvent,
  type RoundReceipt,
  type SessionInfo,
  type StakeComplex,
  type StepOutcome,
} from "@open-rgs/contract";

interface Recorded {
  stakes: StakeComplex[];
  awards: AwardComplex[];
  closes: CloseComplex[];
}

class Wallet implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  balance = 10_000;
  readonly recorded: Recorded = { stakes: [], awards: [], closes: [] };
  private readonly seen = new Map<string, RoundReceipt>();

  constructor(private readonly supports: { stake: boolean; award: boolean } = { stake: true, award: true }) {
    if (!supports.stake) delete (this as Partial<PlatformAdapter>).stakeComplex;
    if (!supports.award) delete (this as Partial<PlatformAdapter>).awardComplex;
  }

  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return {
      sessionId,
      currency: "USD",
      currencyDecimals: 2,
      balance: this.balance,
      allowedBets: [100],
      defaultBetIndex: 0,
    };
  }
  async settleSimple(): Promise<RoundReceipt> {
    return { roundId: "s1", balance: this.balance };
  }
  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    this.balance -= req.bet * (req.priceMultiplier ?? 1);
    return { roundId: "r1", balance: this.balance };
  }
  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    this.recorded.closes.push(req);
    this.balance += req.win;
    return { roundId: req.roundId, balance: this.balance };
  }
  stakeComplex = async (req: StakeComplex): Promise<RoundReceipt> => {
    const replay = req.idempotencyKey ? this.seen.get(req.idempotencyKey) : undefined;
    if (replay) return replay;
    this.recorded.stakes.push(req);
    if (req.stake > this.balance) throw new Error("InsufficientFunds");
    this.balance -= req.stake;
    const receipt = { roundId: req.roundId, balance: this.balance };
    if (req.idempotencyKey) this.seen.set(req.idempotencyKey, receipt);
    return receipt;
  };
  awardComplex = async (req: AwardComplex): Promise<RoundReceipt> => {
    const replay = req.idempotencyKey ? this.seen.get(req.idempotencyKey) : undefined;
    if (replay) return replay;
    this.recorded.awards.push(req);
    this.balance += req.win;
    const receipt = { roundId: req.roundId, balance: this.balance };
    if (req.idempotencyKey) this.seen.set(req.idempotencyKey, receipt);
    return receipt;
  };
  onEvent(_handler: (event: PlatformEvent) => void) {}
}

/** A round whose steps do whatever the test asks, then closes for `closeWin`. */
function mathThatSteps(steps: StepOutcome[], closeMultiplier = 0): ComplexMath {
  let index = 0;
  return {
    kind: "complex",
    name: "stepper",
    version: "1",
    rtp: 1,
    open: () => ({ state: "{}", ops: [], awaiting: { type: "go" } }),
    step: () => {
      const outcome = steps[Math.min(index++, steps.length - 1)]!;
      return outcome;
    },
    isTerminal: () => index >= steps.length,
    close: () => ({ multiplier: closeMultiplier, ops: [], type: "win" }),
  };
}

async function setup(
  steps: StepOutcome[],
  options: { closeMultiplier?: number; maxWin?: number; supports?: { stake: boolean; award: boolean } } = {},
) {
  const platform = new Wallet(options.supports ?? { stake: true, award: true });
  const manifest = defineGame({
    id: "g",
    declaredRtp: 1,
    defaultMode: "base",
    ...(options.maxWin !== undefined ? { maxWinMultiplier: options.maxWin } : {}),
    modes: { base: { math: mathThatSteps(steps, options.closeMultiplier ?? 0), stakeMultiplier: 1 } },
  });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  await orch.init({ sid: `s-${Math.random()}` }, conn);
  return { orch, conn, platform };
}

describe("a step that takes more money", () => {
  test("debits it, keeps the round open, and says so in the response", async () => {
    const { orch, conn, platform } = await setup([
      { state: "{}", ops: [], awaiting: { type: "go" }, stake: 2 },
    ]);
    await orch.openRound({ betIndex: 0 }, conn);
    expect(platform.balance).toBe(9_900);

    const step = await orch.stepRound({ action: { type: "go" } }, conn);

    expect(platform.recorded.stakes).toHaveLength(1);
    expect(platform.recorded.stakes[0]).toMatchObject({ stake: 200, multiplier: 2 });
    expect(step.stake).toBe(200);
    expect(step.balance).toBe(9_700);
    expect(platform.balance).toBe(9_700);
  });

  test("refuses when the player cannot afford it, and takes nothing", async () => {
    const { orch, conn, platform } = await setup([
      { state: "{}", ops: [], awaiting: { type: "go" }, stake: 1_000 },
    ]);
    await orch.openRound({ betIndex: 0 }, conn);
    const before = platform.balance;

    await expect(orch.stepRound({ action: { type: "go" } }, conn)).rejects.toMatchObject({
      code: "INSUFFICIENT_BALANCE",
    });
    expect(platform.recorded.stakes).toHaveLength(0);
    expect(platform.balance).toBe(before);
  });

  test("fails the step when the wallet does not implement stakeComplex", async () => {
    const { orch, conn } = await setup([{ state: "{}", ops: [], awaiting: { type: "go" }, stake: 1 }], {
      supports: { stake: false, award: true },
    });
    await orch.openRound({ betIndex: 0 }, conn);

    const error = await orch.stepRound({ action: { type: "go" } }, conn).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "STEP_FAILED" });
    expect(String(error)).toContain("stakeComplex");
  });

  test("raises what the round has cost, so the close pays on the larger stake", async () => {
    const { orch, conn, platform } = await setup(
      [{ state: "{}", ops: [], awaiting: undefined, stake: 1 }],
      { closeMultiplier: 3 },
    );
    await orch.openRound({ betIndex: 0 }, conn);
    await orch.stepRound({ action: { type: "go" } }, conn);
    await orch.closeRound({}, conn);

    // 100 opening + 100 mid-round = 200 of cost; a 3x close is 600, not 300.
    expect(platform.recorded.closes[0]?.win).toBe(600);
  });
});

describe("a step that pays out", () => {
  test("credits it without closing the round", async () => {
    const { orch, conn, platform } = await setup([
      { state: "{}", ops: [], awaiting: { type: "go" }, award: 5, awardType: "free-spin-win" },
    ]);
    await orch.openRound({ betIndex: 0 }, conn);
    const step = await orch.stepRound({ action: { type: "go" } }, conn);

    expect(platform.recorded.awards[0]).toMatchObject({ win: 500, multiplier: 5, type: "free-spin-win" });
    expect(step.win).toBe(500);
    expect(platform.balance).toBe(10_400);
    expect(platform.recorded.closes).toHaveLength(0);
  });

  test("fails the step when the wallet does not implement awardComplex", async () => {
    const { orch, conn } = await setup([{ state: "{}", ops: [], awaiting: { type: "go" }, award: 1 }], {
      supports: { stake: true, award: false },
    });
    await orch.openRound({ betIndex: 0 }, conn);

    const error = await orch.stepRound({ action: { type: "go" } }, conn).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "STEP_FAILED" });
    expect(String(error)).toContain("awardComplex");
  });

  test("spends the round's max-win allowance rather than resetting it", async () => {
    const { orch, conn, platform } = await setup(
      [{ state: "{}", ops: [], awaiting: undefined, award: 8 }],
      { closeMultiplier: 8, maxWin: 10 },
    );
    await orch.openRound({ betIndex: 0 }, conn);
    await orch.stepRound({ action: { type: "go" } }, conn);
    await orch.closeRound({}, conn);

    // 8x paid mid-round leaves 2x of a 10x cap, so the 8x close is capped.
    expect(platform.recorded.awards[0]?.win).toBe(800);
    expect(platform.recorded.closes[0]?.win).toBe(200);
    expect(platform.recorded.closes[0]?.type).toBe("max_win_reached");
  });

  test("caps a single mid-round award at the round's ceiling", async () => {
    const { orch, conn, platform } = await setup(
      [{ state: "{}", ops: [], awaiting: { type: "go" }, award: 50 }],
      { maxWin: 10 },
    );
    await orch.openRound({ betIndex: 0 }, conn);
    await orch.stepRound({ action: { type: "go" } }, conn);

    expect(platform.recorded.awards[0]?.win).toBe(1_000);
  });
});

describe("both in one step", () => {
  test("takes before it gives", async () => {
    const { orch, conn, platform } = await setup([
      { state: "{}", ops: [], awaiting: { type: "go" }, stake: 1, award: 4 },
    ]);
    await orch.openRound({ betIndex: 0 }, conn);
    const step = await orch.stepRound({ action: { type: "go" } }, conn);

    expect(platform.recorded.stakes).toHaveLength(1);
    expect(platform.recorded.awards).toHaveLength(1);
    // The award is a multiple of the round's cost *after* the extra stake:
    // 100 + 100 = 200, so 4x is 800.
    expect(platform.recorded.awards[0]?.win).toBe(800);
    expect(step.stake).toBe(100);
    expect(step.win).toBe(800);
  });
});

describe("keys", () => {
  test("each step's movements carry a deterministic key", async () => {
    const { orch, conn, platform } = await setup([
      { state: "{}", ops: [], awaiting: { type: "go" }, award: 1 },
      { state: "{}", ops: [], awaiting: { type: "go" }, award: 1 },
    ]);
    await orch.openRound({ betIndex: 0 }, conn);
    await orch.stepRound({ action: { type: "go" } }, conn);
    await orch.stepRound({ action: { type: "go" } }, conn);

    const keys = platform.recorded.awards.map((award) => award.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain("award");
    // The step index is in the key, so a resent step is the same movement.
    expect(keys[0]).not.toBe(keys[1]);
  });
});
