// H12  - the reference wallet is what adapter authors copy, so it must model
// the correct safety posture: dedupe on idempotencyKey, collision-free round
// ids, reject non-integer/negative amounts, and guard the promo pool. (The
// package previously shipped zero tests  - audit M12.)

import { describe, expect, test } from "bun:test";
import { MockPlatform } from "../src/index.js";
import type { SettleSimple, CloseComplex } from "@open-rgs/contract";

function settle(over: Partial<SettleSimple> = {}): SettleSimple {
  return {
    sessionId: "s1", bet: 100, betIndex: 0, priceMultiplier: 1,
    win: 200, multiplier: 2, type: "win", roundState: "{}",
    idempotencyKey: "k1", ...over,
  };
}

describe("MockPlatform idempotency (H12)", () => {
  test("a repeated settle key moves money once and returns the original receipt", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect();
    await p.openSession("s1", "c1");

    const r1 = await p.settleSimple(settle());            // 1000 - 100 + 200 = 1100
    const r2 = await p.settleSimple(settle());            // retry  - must NOT move money again
    expect(r1.balance).toBe(1100);
    expect(r2.balance).toBe(1100);
    expect(r2.roundId).toBe(r1.roundId);
    expect(p.balanceOf("s1")).toBe(1100);                 // single movement
  });

  test("a repeated close key credits once", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect();
    await p.openSession("s1", "c1");
    const open = await p.openComplex({ sessionId: "s1", bet: 100, betIndex: 0, priceMultiplier: 1, initialState: "{}", idempotencyKey: "o1" });
    const close: CloseComplex = { sessionId: "s1", roundId: open.roundId, finalState: "{}", win: 500, multiplier: 5, type: "win", idempotencyKey: "c-key" };
    const c1 = await p.closeComplex(close);               // 900 + 500 = 1400
    const c2 = await p.closeComplex(close);               // retry  - no double credit
    expect(c1.balance).toBe(1400);
    expect(c2.balance).toBe(1400);
    expect(p.balanceOf("s1")).toBe(1400);
  });
});

describe("MockPlatform round ids are monotonic (H12)", () => {
  test("two opens in the same tick get distinct ids", async () => {
    const p = new MockPlatform({ startingBalance: 10_000, currency: "USD" });
    await p.connect();
    await p.openSession("a", "c"); await p.openSession("b", "c");
    const ra = await p.openComplex({ sessionId: "a", bet: 100, betIndex: 0, priceMultiplier: 1, initialState: "{}", idempotencyKey: "ka" });
    const rb = await p.openComplex({ sessionId: "b", bet: 100, betIndex: 0, priceMultiplier: 1, initialState: "{}", idempotencyKey: "kb" });
    expect(ra.roundId).not.toBe(rb.roundId);
  });
});

describe("MockPlatform rejects bad amounts (H12)", () => {
  test("non-integer win is rejected", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    await expect(p.settleSimple(settle({ win: 12.5, idempotencyKey: "frac" }))).rejects.toThrow(/InvalidAmount/);
  });
  test("negative win is rejected", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    await expect(p.settleSimple(settle({ win: -5, idempotencyKey: "neg" }))).rejects.toThrow(/InvalidAmount/);
  });
});

describe("MockPlatform guards the promo pool (H12)", () => {
  test("a promo settle with no pool is rejected (no free settle)", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    await expect(p.settleSimple(settle({ promoId: "nope", idempotencyKey: "p1" }))).rejects.toThrow(/promo pool/);
  });
  test("a valid promo settle decrements the pool and doesn't debit balance", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    p.grantPromo("s1", { id: "promo-1", bet: 100, remaining: 2 });
    const r = await p.settleSimple(settle({ promoId: "promo-1", win: 0, idempotencyKey: "p2" }));
    expect(r.promo).toEqual({ remaining: 1 });
    expect(p.balanceOf("s1")).toBe(1000); // free round  - no debit
  });
});
