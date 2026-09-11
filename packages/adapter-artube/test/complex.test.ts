// The complex-round half of the wire, checked frame by frame.
//
// These assertions are about the things a passing balance cannot prove:
// which message type went out, what round_version rode on it, what ended up
// in the wallet's one round_state slot, and whether an autoclose the
// platform asked for came back as the autoclose message it expects.

import { afterEach, describe, expect, test } from "bun:test";
import type { PlatformEvent } from "@open-rgs/contract";
import { ArtubeAdapter } from "../src/index.js";
import { fakeArtube, type FakeArtube, type FakeArtubeOptions } from "./fake-artube.js";

let open: { fake: FakeArtube; adapter: ArtubeAdapter } | null = null;

async function connect(opts: FakeArtubeOptions = {}, adapterOpts: Record<string, unknown> = {}) {
  const fake = fakeArtube(opts);
  const events: PlatformEvent[] = [];
  const adapter = new ArtubeAdapter({
    wsUrl: fake.url,
    gameId: "complex-test",
    authToken: "test-key",
    handshakeTimeoutMs: 5_000,
    rpcTimeoutMs: 5_000,
    ...adapterOpts,
  });
  adapter.onEvent((e) => events.push(e));
  await adapter.connect();
  open = { fake, adapter };
  return { fake, adapter, events };
}

afterEach(() => {
  open?.adapter.disconnect();
  open?.fake.stop();
  open = null;
});

/** Wait for `pred` to hold, or fail loudly. Events arrive on the socket, so
 *  a bare assertion right after a send is a race. */
async function until(pred: () => boolean, what: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

describe("complex rounds", () => {
  test("open -> update -> close threads the wallet's round_version", async () => {
    const { fake, adapter } = await connect();
    await adapter.openSession("s1", "c1");

    const opened = await adapter.openComplex({
      sessionId: "s1", bet: 100, betIndex: 2, priceMultiplier: 1,
      initialState: JSON.stringify({ step: 1 }),
      mathVersion: "3.2.1",
    });
    expect(opened.roundId).toBeTruthy();
    expect(opened.balance).toBe(1_000_000 - 100);

    await adapter.updateComplex!({ sessionId: "s1", roundId: opened.roundId, state: JSON.stringify({ step: 2 }) });
    await adapter.updateComplex!({ sessionId: "s1", roundId: opened.roundId, state: JSON.stringify({ step: 3 }) });

    const closed = await adapter.closeComplex({
      sessionId: "s1", roundId: opened.roundId,
      finalState: JSON.stringify({ step: 4 }),
      win: 400, multiplier: 4, type: "win",
    });
    expect(closed.balance).toBe(1_000_000 - 100 + 400);

    // 0 from the open, then each update answers with the next one. A stale
    // number here is InvalidRoundOperation on the real platform, which is
    // why this is asserted on the frames and not just on the balance.
    expect(fake.sent("UpdateRoundStateRequest").map((f) => f.payload["round_version"])).toEqual([0, 1]);
    expect(fake.sent("CloseRoundRequest")[0]!.payload["round_version"]).toBe(2);
    expect(fake.sent("OpenRoundRequest")[0]!.payload["round_state_version"]).toBe("3.2.1");
  });

  test("the close packs final state AND carry into the one state slot", async () => {
    const { fake, adapter } = await connect();
    await adapter.openSession("s2", "c1");
    const opened = await adapter.openComplex({
      sessionId: "s2", bet: 100, betIndex: 2, priceMultiplier: 1,
      initialState: JSON.stringify({ step: 1 }),
    });
    await adapter.closeComplex({
      sessionId: "s2", roundId: opened.roundId,
      finalState: JSON.stringify({ step: 9, pending: 0 }),
      carry: JSON.stringify({ meterPoints: 42 }),
      win: 0, multiplier: 0, type: "loss",
      mathVersion: "1.0.0",
    });

    const stored = fake.lastRoundState("s2")!;
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    // The audit record keeps the round's own final state...
    expect(parsed["state"]).toEqual({ step: 9, pending: 0 });
    // ...and the carry rides alongside it rather than overwriting it.
    expect(parsed["carry"]).toEqual({ meterPoints: 42 });

    // And it comes back out as the carry for the next round.
    const info = await adapter.openSession("s2", "c2");
    expect(JSON.parse(info.carry!)).toEqual({ meterPoints: 42 });
    expect(info.mathVersion).toBe("1.0.0");
  });

  test("a round_state written without an envelope still reads back as carry", async () => {
    // Simple rounds write their state unpacked, and so did every round
    // written before the envelope existed. Reading one must not return an
    // empty carry and silently reset a player's meters.
    const { adapter } = await connect();
    await adapter.openSession("s3", "c1");
    await adapter.settleSimple({
      sessionId: "s3", bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss",
      roundState: JSON.stringify({ meterPoints: 7 }),
      mathVersion: "1.0.0",
    });
    const info = await adapter.openSession("s3", "c2");
    expect(JSON.parse(info.carry!)).toEqual({ meterPoints: 7 });
  });

  test("features declared by the math are sent, and open ∪ close is what closes", async () => {
    const { fake, adapter } = await connect();
    await adapter.openSession("s4", "c1");
    const opened = await adapter.openComplex({
      sessionId: "s4", bet: 100, betIndex: 2, priceMultiplier: 1,
      initialState: JSON.stringify({ $features: ["BonusGame"] }),
    });
    await adapter.closeComplex({
      sessionId: "s4", roundId: opened.roundId,
      finalState: JSON.stringify({ $features: ["PlayedGamble"] }),
      win: 200, multiplier: 2, type: "win",
    });
    expect(fake.sent("OpenRoundRequest")[0]!.payload["features"]).toEqual([{ type: "BonusGame" }]);
    const closeFeatures = fake.sent("CloseRoundRequest")[0]!.payload["features"] as { type: string }[];
    expect(new Set(closeFeatures.map((f) => f.type))).toEqual(new Set(["BonusGame", "PlayedGamble"]));
  });

  test("a platform autoclose comes back as AutocloseRoundRequest, not CloseRound", async () => {
    const { fake, adapter, events } = await connect();
    await adapter.openSession("s5", "c1");
    const opened = await adapter.openComplex({
      sessionId: "s5", bet: 100, betIndex: 2, priceMultiplier: 1,
      initialState: JSON.stringify({ step: 1 }),
    });
    await adapter.updateComplex!({ sessionId: "s5", roundId: opened.roundId, state: JSON.stringify({ step: 2 }) });

    fake.requestAutoclose(opened.roundId);
    await until(() => events.some((e) => e.type === "autocloseRequested"), "autocloseRequested event");

    const asked = events.find((e) => e.type === "autocloseRequested")!;
    expect(asked).toMatchObject({ type: "autocloseRequested", sessionId: "s5", roundId: opened.roundId });

    // This is what the orchestrator does with that event: close the round,
    // stamping the reason. The reason is the only thing that tells the
    // adapter to use the autoclose message.
    await adapter.closeComplex({
      sessionId: "s5", roundId: opened.roundId,
      finalState: JSON.stringify({ step: 3 }),
      win: 150, multiplier: 1.5, type: "autoclose-settled",
      reason: "platform-autoclose",
    });

    expect(fake.sent("AutocloseRoundRequest").length).toBe(1);
    expect(fake.sent("CloseRoundRequest").length).toBe(0);
    expect(fake.sent("AutocloseRoundRequest")[0]!.payload["round_version"]).toBe(1);
    expect(fake.balanceMinor("s5")).toBe(1_000_000 - 100 + 150);
  });

  test("events are understood with or without the Event suffix", async () => {
    const { fake, adapter, events } = await connect({ eventSuffix: false });
    await adapter.openSession("s6", "c1");
    await adapter.settleSimple({
      sessionId: "s6", bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss", roundState: "{}",
    });
    await until(() => events.some((e) => e.type === "balanceChanged"), "balanceChanged event");
    const bal = events.find((e) => e.type === "balanceChanged")!;
    // ...and the balance on it is scaled like every other amount, not left
    // in the wallet's major units.
    expect(bal).toMatchObject({ type: "balanceChanged", sessionId: "s6" });
    expect((bal as { balance: number }).balance).toBe(fake.balanceMinor("s6"));
  });

  test("an open does not chain itself to whatever round came before", async () => {
    // previous_round_id links a round to the one it continues - a bonus to
    // the base round that triggered it. Sending the last round this adapter
    // happened to close is a different claim, and the platform refuses it
    // with "Invalid rounds sequence" whenever the guess is wrong: after a
    // simple settle, after another pod served a round, after a restart.
    const { fake, adapter } = await connect();
    await adapter.openSession("chain", "c1");
    await adapter.settleSimple({
      sessionId: "chain", bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss", roundState: "{}",
    });
    const first = await adapter.openComplex({
      sessionId: "chain", bet: 100, betIndex: 2, priceMultiplier: 1, initialState: "{}",
    });
    await adapter.closeComplex({
      sessionId: "chain", roundId: first.roundId,
      finalState: "{}", win: 0, multiplier: 0, type: "loss",
    });
    // The one that used to fail: a complex open straight after a complex
    // close, with a simple round's settle in between having moved the
    // wallet's idea of "previous" on.
    await adapter.settleSimple({
      sessionId: "chain", bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 0, multiplier: 0, type: "loss", roundState: "{}",
    });
    const second = await adapter.openComplex({
      sessionId: "chain", bet: 100, betIndex: 2, priceMultiplier: 1, initialState: "{}",
    });
    expect(second.roundId).toBeTruthy();
    for (const frame of fake.sent("OpenRoundRequest")) {
      expect(frame.payload["previous_round_id"]).toBeUndefined();
    }
  });

  test("closing a round this adapter never opened is refused locally", async () => {
    // Not forwarded as a guessed round_version: the money for such a round
    // was moved by an open we never saw, and a wrong version is either
    // refused or lands on something else entirely.
    const { fake, adapter } = await connect();
    await adapter.openSession("s7", "c1");
    await expect(adapter.closeComplex({
      sessionId: "s7", roundId: "no-such-round",
      finalState: "{}", win: 0, multiplier: 0, type: "loss",
    })).rejects.toThrow(/no open round/);
    expect(fake.sent("CloseRoundRequest").length).toBe(0);
  });

  test("a failed close keeps the round open for a retry", async () => {
    const { fake, adapter } = await connect();
    await adapter.openSession("s8", "c1");
    const opened = await adapter.openComplex({
      sessionId: "s8", bet: 100, betIndex: 2, priceMultiplier: 1,
      initialState: "{}",
    });
    // Desync the adapter's round_version the way a dropped UpdateRoundState
    // response would, so the wallet refuses the close.
    await adapter.updateComplex!({ sessionId: "s8", roundId: opened.roundId, state: "{}" });
    (adapter as unknown as { rounds: Map<string, { version: number }> }).rounds.get(opened.roundId)!.version = 0;

    await expect(adapter.closeComplex({
      sessionId: "s8", roundId: opened.roundId,
      finalState: "{}", win: 0, multiplier: 0, type: "loss",
    })).rejects.toThrow(/InvalidRoundOperation/);

    // Still ours to retry: the book entry survived, and so did the wallet's
    // open round.
    expect(fake.openRoundIds()).toContain(opened.roundId);
    (adapter as unknown as { rounds: Map<string, { version: number }> }).rounds.get(opened.roundId)!.version = 1;
    const closed = await adapter.closeComplex({
      sessionId: "s8", roundId: opened.roundId,
      finalState: "{}", win: 100, multiplier: 1, type: "win",
    });
    expect(closed.balance).toBe(1_000_000);
  });

  test("without currency_minimal_unit the configured decimals are used", async () => {
    const { adapter } = await connect({ sendMinimalUnit: false }, { currencyDecimals: 2 });
    const info = await adapter.openSession("s9", "c1");
    expect(info.balance).toBe(1_000_000);
    expect(info.allowedBets).toEqual([25, 50, 100, 200, 500, 1000]);
  });

  test("verbatim scaling passes the wallet's own numbers through", async () => {
    // The escape hatch, for a wallet already configured in minor units.
    const { adapter } = await connect({}, { amountScaling: "verbatim" });
    const info = await adapter.openSession("s10", "c1");
    expect(info.balance).toBe(10_000);
    expect(info.allowedBets).toEqual([0.25, 0.5, 1, 2, 5, 10]);
  });

  test("schema 2 declares every contract type it can receive", async () => {
    // Artube filters the connection to what Hello declared: a type left out
    // is never delivered. Assert the declaration is complete rather than
    // whatever was needed the day it was written.
    const { fake } = await connect({ welcomeSchema: 2 }, { schemaVersion: 2 });
    // The fake answers Welcome on open, so connect() can resolve before it
    // has processed the Hello that crossed the other way.
    await until(() => fake.sent("Hello").length > 0, "Hello frame");
    const hello = fake.sent("Hello")[0]!;
    expect(hello.schema).toBe(2);
    const supports = hello.payload["supports"] as { contracts: Record<string, unknown> };
    expect(Object.keys(supports.contracts).sort()).toEqual([
      "AutocloseRequestEvent", "AutocloseRoundRequest",
      "BalanceChangedEvent",
      "CloseRoundRequest", "CloseRoundResponse",
      "Error",
      "NewConnectionEvent",
      "OpenRoundRequest", "OpenRoundResponse",
      "PlayRoundRequest", "PlayRoundResponse",
      "SessionClosedEvent",
      "SessionInfoRequest", "SessionInfoResponse",
      "UpdateRoundStateRequest", "UpdateRoundStateResponse",
    ]);
  });
});
