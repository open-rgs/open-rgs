// Demo sessions never reach the wire.
//
// Artube has no demo requests: the marker is a session whose currency is
// null, and from there the backend keeps the play balance itself. The thing
// worth testing is therefore negative - that nothing went to the wallet -
// as much as it is that the arithmetic is right.

import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformEvent } from "@open-rgs/contract";
import { ArtubeAdapter, withDemoSessions } from "../src/index.js";
import { fakeArtube, type FakeArtube } from "./fake-artube.js";

async function until(pred: () => boolean, what: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

const DEMO = "demo-session";
const REAL = "real-session";

let open: { fake: FakeArtube; adapter: ArtubeAdapter } | null = null;

async function connect(startingBalance = 1_000_000) {
  const fake = fakeArtube({ demoSessions: [DEMO] });
  const events: PlatformEvent[] = [];
  const adapter = new ArtubeAdapter({
    wsUrl: fake.url, gameId: "demo-test", authToken: "k",
    handshakeTimeoutMs: 5_000, rpcTimeoutMs: 5_000,
  });
  const platform = withDemoSessions(adapter, { startingBalance });
  platform.onEvent((e) => events.push(e));
  await platform.connect();
  open = { fake, adapter };
  return { fake, platform, events };
}

afterEach(() => {
  open?.adapter.disconnect();
  open?.fake.stop();
  open = null;
});

describe("demo sessions", () => {
  test("a session with no currency gets play money, and the wallet is not asked for it", async () => {
    const { fake, platform } = await connect(500_000);
    const info = await platform.openSession(DEMO, "c1");
    expect(info.currency).toBeFalsy();       // what makes it demo
    expect(info.balance).toBe(500_000);      // ours, not the wallet's 1,000,000
    // The ladder still comes from the wallet: it is not money, and a demo
    // player must be able to bet the same amounts as a real one.
    expect(info.allowedBets).toEqual([25, 50, 100, 200, 500, 1000]);
    expect(fake.sent("SessionInfoRequest").length).toBe(1);
  });

  test("a simple round moves the play balance and sends nothing", async () => {
    const { fake, platform } = await connect();
    await platform.openSession(DEMO, "c1");
    const r = await platform.settleSimple({
      sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 250, multiplier: 2.5, type: "win", roundState: JSON.stringify({ meter: 3 }),
    });
    expect(r.balance).toBe(1_000_000 - 100 + 250);
    expect(fake.sent("PlayRoundRequest").length).toBe(0);
  });

  test("a complex round debits at open and credits at close, still off the wire", async () => {
    const { fake, platform } = await connect();
    await platform.openSession(DEMO, "c1");
    const opened = await platform.openComplex({
      sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1, initialState: "{}",
    });
    expect(opened.balance).toBe(1_000_000 - 100);
    await platform.updateComplex!({ sessionId: DEMO, roundId: opened.roundId, state: "{}" });
    const closed = await platform.closeComplex({
      sessionId: DEMO, roundId: opened.roundId,
      finalState: "{}", win: 400, multiplier: 4, type: "win",
    });
    expect(closed.balance).toBe(1_000_000 - 100 + 400);
    expect(fake.sent("OpenRoundRequest").length).toBe(0);
    expect(fake.sent("UpdateRoundStateRequest").length).toBe(0);
    expect(fake.sent("CloseRoundRequest").length).toBe(0);
  });

  test("one open round at a time, the same as the wallet enforces", async () => {
    const { platform } = await connect();
    await platform.openSession(DEMO, "c1");
    await platform.openComplex({ sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1, initialState: "{}" });
    await expect(platform.openComplex({
      sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1, initialState: "{}",
    })).rejects.toThrow(/already open/);
  });

  test("the carry threads across demo rounds, in memory", async () => {
    const { platform } = await connect();
    await platform.openSession(DEMO, "c1");
    await platform.settleSimple({
      sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss",
      roundState: JSON.stringify({ meter: 7 }), mathVersion: "1.0.0",
    });
    const again = await platform.openSession(DEMO, "c2");
    expect(JSON.parse(again.carry!)).toEqual({ meter: 7 });
    expect(again.mathVersion).toBe("1.0.0");
  });

  test("the round state is stored too, not just the balance", async () => {
    // The wallet would be holding round_state through the whole round: the
    // state at open, every update, the final one at close. A demo round that
    // kept only the money would behave differently from a real one in the
    // one place a game actually reads.
    const { platform } = await connect();
    await platform.openSession(DEMO, "c1");
    const opened = await platform.openComplex({
      sessionId: DEMO, bet: 100, betIndex: 3, priceMultiplier: 1,
      initialState: JSON.stringify({ step: 1 }), mathVersion: "2.0.0",
    });

    let view = platform.demoSessionFor(DEMO)!;
    expect(view.openRound?.roundId).toBe(opened.roundId);
    expect(JSON.parse(view.openRound!.state)).toEqual({ step: 1 });
    expect(view.openRound?.betIndex).toBe(3);
    expect(view.openRound?.version).toBe(0);

    await platform.updateComplex!({ sessionId: DEMO, roundId: opened.roundId, state: JSON.stringify({ step: 2 }) });
    view = platform.demoSessionFor(DEMO)!;
    expect(JSON.parse(view.openRound!.state)).toEqual({ step: 2 });
    expect(view.openRound?.version).toBe(1);

    await platform.closeComplex({
      sessionId: DEMO, roundId: opened.roundId,
      finalState: JSON.stringify({ step: 3 }),
      carry: JSON.stringify({ meter: 9 }),
      win: 200, multiplier: 2, type: "win", mathVersion: "2.0.0",
    });
    view = platform.demoSessionFor(DEMO)!;
    expect(view.openRound).toBeUndefined();
    // And the finished round is kept the way last_round would be.
    expect(JSON.parse(view.lastRound!.state)).toEqual({ step: 3 });
    expect(view.lastRound?.win).toBe(200);
    expect(view.lastRound?.finishedAt).toBeDefined();
    expect(JSON.parse(view.carry!)).toEqual({ meter: 9 });
  });

  test("a real session has no demo store at all", async () => {
    const { platform } = await connect();
    await platform.openSession(REAL, "c1");
    expect(platform.demoSessionFor(REAL)).toBeUndefined();
  });

  test("a real session is untouched by any of this", async () => {
    const { fake, platform } = await connect();
    const info = await platform.openSession(REAL, "c1");
    expect(info.currency).toBe("USD");
    expect(info.balance).toBe(1_000_000);    // the wallet's, not ours
    const r = await platform.settleSimple({
      sessionId: REAL, bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 250, multiplier: 2.5, type: "win", roundState: "{}",
    });
    expect(r.balance).toBe(1_000_000 - 100 + 250);
    expect(fake.sent("PlayRoundRequest").length).toBe(1);
  });

  test("the session ending takes the play money with it", async () => {
    // Artube does not persist a demo round, so there is nothing to come back
    // to - and keeping the balance would make the next session start rich, or
    // poor, depending on how the last one went.
    const { fake, platform, events } = await connect();
    await platform.openSession(DEMO, "c1");
    await platform.settleSimple({
      sessionId: DEMO, bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss", roundState: "{}",
    });
    expect((await platform.openSession(DEMO, "c2")).balance).toBe(1_000_000 - 100);

    fake.closeSession(DEMO);
    await until(() => events.some((e) => e.type === "sessionClosed"), "sessionClosed");

    // Fresh session, fresh play money.
    expect((await platform.openSession(DEMO, "c3")).balance).toBe(1_000_000);
  });

  test("a real wallet's balance event never lands on a demo session", async () => {
    // The event carries someone's real balance. Letting it through would
    // overwrite the play balance with it.
    const { fake, platform, events } = await connect();
    await platform.openSession(DEMO, "c1");
    await platform.openSession(REAL, "c2");
    await platform.settleSimple({
      sessionId: REAL, bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss", roundState: "{}",
    });
    await until(() => events.some((e) => e.type === "balanceChanged"), "balanceChanged");
    expect(events.filter((e) => e.type === "balanceChanged").every((e) => e.sessionId === REAL)).toBe(true);
  });
});
