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

describe("MockPlatform reversal  - Guarantee 2, One Round One Record", () => {
  // Carry rides the settle (Guarantee 1) and reverses WITH the money (Guarantee 2).
  const spin = (over: Partial<SettleSimple>): SettleSimple => settle({ win: 0, idempotencyKey: undefined, ...over });

  test("reversing a round restores BOTH balance and carry to pre-round", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    // Round 1: bet 100, win 0, carry "progress=1".
    const r1 = await p.settleSimple(spin({ bet: 100, win: 0, roundState: JSON.stringify({ progress: 1 }) }));
    expect(p.balanceOf("s1")).toBe(900);
    const rev = await p.reverseRound({ sessionId: "s1", roundId: r1.roundId, reason: "chargeback" });
    expect(rev.reversed).toBe(true);
    expect(rev.balance).toBe(1000);          // money restored
    expect(rev.carry).toBeUndefined();        // carry restored to pre-round (none)
    expect(p.balanceOf("s1")).toBe(1000);
  });

  test("OUT-OF-ORDER reversal is rejected  - no over-refund (the bug this guarantee forbids)", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    const a = await p.settleSimple(spin({ bet: 100, win: 0 })); // 1000 -> 900
    const b = await p.settleSimple(spin({ bet: 100, win: 0 })); // 900 -> 800
    const c = await p.settleSimple(spin({ bet: 100, win: 0 })); // 800 -> 700
    // Try to reverse the OLDEST (a) while b and c sit on top. Must refuse  -
    // restoring a's pre-state (1000) would silently refund b and c too.
    const bad = await p.reverseRound({ sessionId: "s1", roundId: a.roundId, reason: "x" });
    expect(bad.reversed).toBe(false);
    expect(bad.reason).toBe("not-latest-round");
    expect(p.balanceOf("s1")).toBe(700);     // untouched  - no over-refund
    // Latest-first works: reverse c, then b, then a.
    expect((await p.reverseRound({ sessionId: "s1", roundId: c.roundId, reason: "x" })).balance).toBe(800);
    expect((await p.reverseRound({ sessionId: "s1", roundId: b.roundId, reason: "x" })).balance).toBe(900);
    expect((await p.reverseRound({ sessionId: "s1", roundId: a.roundId, reason: "x" })).balance).toBe(1000);
  });

  test("reversing the same round twice is a safe no-op (no double credit)", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    const r = await p.settleSimple(spin({ bet: 100, win: 0 }));
    const first = await p.reverseRound({ sessionId: "s1", roundId: r.roundId, reason: "x", idempotencyKey: "rev1" });
    const again = await p.reverseRound({ sessionId: "s1", roundId: r.roundId, reason: "x", idempotencyKey: "rev1" });
    expect(first.reversed).toBe(true);
    expect(again.balance).toBe(first.balance);
    expect(p.balanceOf("s1")).toBe(1000);    // not 1100  - reversed once
  });

  test("a complex round reverses money AND the carry it committed", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    const open = await p.openComplex({ sessionId: "s1", bet: 100, betIndex: 0, priceMultiplier: 1, initialState: "{}", idempotencyKey: "o1" }); // 1000 -> 900
    await p.closeComplex({ sessionId: "s1", roundId: open.roundId, finalState: "{}", carry: JSON.stringify({ meter: 9 }), win: 300, multiplier: 3, type: "win", idempotencyKey: "cl1" }); // 900 -> 1200, carry meter=9
    expect(p.balanceOf("s1")).toBe(1200);
    const rev = await p.reverseRound({ sessionId: "s1", roundId: open.roundId, reason: "chargeback" });
    expect(rev.reversed).toBe(true);
    expect(rev.balance).toBe(1000);          // both debit and credit undone
    expect(rev.carry).toBeUndefined();        // meter=9 gone  - no rollback farming
  });

  test("reversing an unknown round is a safe no-op", async () => {
    const p = new MockPlatform({ startingBalance: 1000, currency: "USD" });
    await p.connect(); await p.openSession("s1", "c1");
    const rev = await p.reverseRound({ sessionId: "s1", roundId: "r-nope", reason: "x" });
    expect(rev.reversed).toBe(false);
    expect(p.balanceOf("s1")).toBe(1000);
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
