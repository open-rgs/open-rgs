// Run the conformance suite against the adapter.
//
// It cannot point at a real wallet - the suite moves money, opens derived
// sessions and asserts balances, so it only ever belongs against a mock or a
// sandbox. What it CAN do here is run the adapter against a fake Artube server
// speaking the real wire protocol, which is what ./fake-artube.ts is.
//
// Complex-round checks used to be skipped here because the adapter threw on
// them. They run now: the Games API has OpenRound / UpdateRoundState /
// CloseRound and the adapter speaks all three.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runConformance } from "@open-rgs/adapter-test-kit";
import { ArtubeAdapter } from "../src/index.js";
import { fakeArtube, type FakeArtube } from "./fake-artube.js";

let fake: FakeArtube;
let adapter: ArtubeAdapter;

beforeAll(async () => {
  fake = fakeArtube();
  adapter = new ArtubeAdapter({
    wsUrl: fake.url,
    gameId: "conformance",
    authToken: "test-key",
    handshakeTimeoutMs: 5_000,
    rpcTimeoutMs: 5_000,
  });
  await adapter.connect();
});

afterAll(() => {
  adapter.disconnect();
  fake.stop();
});

describe("conformance", () => {
  test("connects and reports healthy", () => {
    expect(adapter.isHealthy).toBe(true);
  });

  test("opens a session with a usable bet ladder, converted to minor units", async () => {
    const info = await adapter.openSession("conf-session", "conn-1");
    // The wallet said 10000.00; open-rgs counts minor units.
    expect(info.balance).toBe(1_000_000);
    expect(info.currency).toBe("USD");
    expect(info.currencyDecimals).toBe(2);
    // Ladder crosses the same way: 0.25 -> 25. Integers, because the
    // orchestrator refuses a fractional bet outright.
    expect(info.allowedBets).toEqual([25, 50, 100, 200, 500, 1000]);
    for (const b of info.allowedBets) expect(Number.isInteger(b)).toBe(true);
    expect(info.allowedBets[info.defaultBetIndex]).toBeDefined();
  });

  test("a settle moves the balance by exactly win minus bet", async () => {
    await adapter.openSession("conf-money", "conn-2");
    // Index 2 is 1.00 on this wallet's ladder, and the win is derived wallet-side
    // from win_multiplier - the adapter's `win` field never crosses the wire.
    const receipt = await adapter.settleSimple({
      sessionId: "conf-money",
      bet: 100, betIndex: 2, priceMultiplier: 1,
      win: 250, multiplier: 2.5, type: "win", roundState: "",
    });
    expect(receipt.balance).toBe(1_000_000 - 100 + 250);
  });

  test("an overspend is refused rather than settled", async () => {
    // Driven through priceMultiplier, not bet. This wire is amount-blind:
    // PlayRoundRequest carries bet_index and price_multiplier, so a giant
    // `bet` never reaches the wallet and could never be refused.
    await adapter.openSession("conf-broke", "conn-3");
    await expect(adapter.settleSimple({
      sessionId: "conf-broke",
      bet: 100, betIndex: 2, priceMultiplier: 1_000_000,
      win: 0, multiplier: 0, type: "loss", roundState: "",
    })).rejects.toThrow();
  });

  // Two checks the Artube wire cannot satisfy, allowlisted with the reason
  // rather than papered over in the fake server. Faking a pass here would hide
  // a real integration limitation behind a green suite.
  const WIRE_CANNOT = new Set([
    // The probe declares an oversized `bet`, but PlayRoundRequest carries
    // bet_index and price_multiplier, never an amount. The wallet computes
    // the stake from its own ladder, so the adapter cannot declare an
    // oversized bet and this probe cannot trip it. (The adapter IS refused
    // on a real overspend - see the test above, which drives
    // priceMultiplier.)
    "errors.insufficient-funds",
  ]);

  test("the suite runs, and only the checks this wire cannot express fail", async () => {
    const report = await runConformance(adapter, {
      fixture: { sessionId: "conf-run" },
      perCheckTimeoutMs: 5_000,
      // Opt in. Parallel settles across sessions and a duplicate key fired
      // twice at once are exactly the shapes a live pod meets and a
      // single-threaded test never does.
      concurrency: true,
    });
    expect(report.checks.length).toBeGreaterThan(0);
    const unexpected = report.checks
      .filter((c) => c.status === "fail" && !WIRE_CANNOT.has(c.id))
      .map((c) => `${c.id}: ${c.message ?? ""}`);
    if (unexpected.length > 0) console.error("unexpected conformance failures:", unexpected);
    expect(unexpected).toEqual([]);
  }, 30_000);

  test("the concurrency certification passes too", async () => {
    // Opt-in, and never opted into before: parallel settles across sessions,
    // and the same idempotency key fired twice at once - which the wallet
    // cannot dedupe, so the adapter has to.
    const report = await runConformance(adapter, {
      fixture: { sessionId: "conf-conc" }, perCheckTimeoutMs: 5_000, concurrency: true,
    });
    const conc = report.checks.filter((c) => c.group === "concurrency");
    const bad = conc.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.message ?? ""}`);
    if (bad.length > 0) console.error("concurrency failures:", bad);
    expect(bad).toEqual([]);
    // The two that move money, by name, so a future skip cannot hide here.
    const byId = new Map(conc.map((c) => [c.id, c.status]));
    expect(byId.get("concurrency.parallel-distinct-settles")).toBe("ok");
    expect(byId.get("concurrency.duplicate-key-parallel")).toBe("ok");
    // Reversal is skipped, not failed: this wire has no game-initiated
    // rollback message, so there is nothing for reverseRound to call.
    expect(byId.get("concurrency.reverse-interleave")).toBe("skip");
  }, 30_000);

  test("the complex-round checks are among the ones that passed", async () => {
    // The point of the change: these three used to be skips.
    const report = await runConformance(adapter, {
      fixture: { sessionId: "conf-complex" },
      perCheckTimeoutMs: 5_000,
      concurrency: true,
    });
    const byId = new Map(report.checks.map((c) => [c.id, c.status]));
    expect(byId.get("complex.openComplex")).toBe("ok");
    expect(byId.get("complex.updateComplex")).toBe("ok");
    expect(byId.get("complex.closeComplex")).toBe("ok");
    expect(byId.get("errors.bad-round-id")).toBe("ok");
  }, 30_000);

  test("the known-unsupported checks really are still failing", async () => {
    // If the wire gains an idempotency field, or the test kit fix lands, this
    // goes red and the allowlist above must shrink. A stale allowlist is how a
    // suite quietly stops testing.
    const report = await runConformance(adapter, {
      fixture: { sessionId: "conf-stale" }, perCheckTimeoutMs: 5_000,
      concurrency: true,
    });
    const failing = new Set(report.checks.filter((c) => c.status === "fail").map((c) => c.id));
    for (const id of WIRE_CANNOT) expect(failing.has(id)).toBe(true);
  }, 30_000);
});
