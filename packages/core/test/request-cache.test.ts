// Request-level idempotency, driven end to end against a real orchestrator and
// the in-memory wallet, so the money assertions are real rather than mocked.
//
// The case that matters is the retry arriving WHILE the first call is still
// running, because that is the one a completed-response cache would miss and it
// is exactly what a client timeout produces.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/orchestrator.js";
import { createRequestCache } from "../src/request-cache.js";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type SimpleMath } from "@open-rgs/contract";

const conn = { connectionId: "c1" } as never;

// The session store in @open-rgs/core is a module-level singleton, so every
// test file in the process shares it. A fixed id collides across
// files and surface as ROUND_ALREADY_OPEN from someone else's round.
let seq = 0;
const sid = () => `reqcache-${++seq}-${Date.now()}`;

function counterMath(): { math: SimpleMath; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    math: {
      kind: "simple", name: "c", version: "1.0.0", rtp: 1,
      play: () => {
        calls++;
        return { multiplier: 2, ops: [{ kind: "spin", n: calls }], type: "win" };
      },
    },
  };
}

async function harness(slowMs = 0) {
  const platform = new MockPlatform({ startingBalance: 100_000 });
  await platform.connect();
  const { math, calls } = counterMath();
  const wrapped: SimpleMath = slowMs
    ? { ...math, play: async (...a) => { await Bun.sleep(slowMs); return math.play(...a); } } as SimpleMath
    : math;
  const orch = createOrchestrator({
    manifest: defineGame({
      id: "idem", declaredRtp: 1, defaultMode: "default",
      modes: { default: { math: wrapped, stakeMultiplier: 1 } },
    }),
    platform,
  });
  return { orch, calls, platform };
}

describe("the cache itself", () => {
  test("no key means no caching", async () => {
    const c = createRequestCache();
    let n = 0;
    const run = () => c.run("s", undefined, async () => ++n);
    expect(await run()).toBe(1);
    expect(await run()).toBe(2);
    expect(c.size).toBe(0);
  });

  test("same key returns the first result", async () => {
    const c = createRequestCache();
    let n = 0;
    const run = () => c.run("s", "k", async () => ++n);
    expect(await run()).toBe(1);
    expect(await run()).toBe(1);
    expect(n).toBe(1);
  });

  test("a repeat arriving MID-FLIGHT coalesces rather than starting a second run", async () => {
    // The dangerous retry: the client timed out at 5s, the round is still
    // running at 6s. Caching only completed responses would let both run.
    const c = createRequestCache();
    let n = 0;
    const slow = async () => { await Bun.sleep(40); return ++n; };
    const [a, b] = await Promise.all([c.run("s", "k", slow), c.run("s", "k", slow)]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(n).toBe(1);
  });

  test("a failure is NOT cached, so the client can retry for real", async () => {
    // Caching failures would turn a transient wallet blip into a permanently
    // poisoned key.
    const c = createRequestCache();
    let n = 0;
    const flaky = async () => { if (++n === 1) throw new Error("boom"); return n; };
    await expect(c.run("s", "k", flaky)).rejects.toThrow("boom");
    expect(await c.run("s", "k", flaky)).toBe(2);
  });

  test("scopes cannot collide - two players may pick the same token", async () => {
    const c = createRequestCache();
    let n = 0;
    expect(await c.run("player-a", "k", async () => ++n)).toBe(1);
    expect(await c.run("player-b", "k", async () => ++n)).toBe(2);
  });

  test("entries expire", async () => {
    const c = createRequestCache({ ttlMs: 20 });
    let n = 0;
    expect(await c.run("s", "k", async () => ++n)).toBe(1);
    await Bun.sleep(40);
    expect(await c.run("s", "k", async () => ++n)).toBe(2);
  });

  test("the store is bounded, oldest evicted first", async () => {
    const c = createRequestCache({ max: 3 });
    for (let i = 0; i < 10; i++) await c.run("s", `k${i}`, async () => i);
    expect(c.size).toBeLessThanOrEqual(3);
  });

  test("clearScope drops one session and leaves others", async () => {
    const c = createRequestCache();
    let n = 0;
    await c.run("a", "k", async () => ++n);
    await c.run("b", "k", async () => ++n);
    c.clearScope("a");
    expect(await c.run("a", "k", async () => ++n)).toBe(3);  // ran again
    expect(await c.run("b", "k", async () => ++n)).toBe(2);  // still cached
  });
});

describe("a retried spin does not run the round twice", () => {
  test("same key: math runs once, money moves once", async () => {
    const id = sid();
    const { orch, calls, platform } = await harness();
    await orch.init({ sid: id }, conn);
    const before = (await platform.openSession(id, "c1")).balance;

    const a = await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "tok-1" }, conn);
    const b = await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "tok-1" }, conn);

    expect(calls()).toBe(1);
    expect(b).toEqual(a);
    expect(b.balance).toBe(a.balance);
    expect((await platform.openSession(id, "c1")).balance).toBe(a.balance);
    expect(a.balance).not.toBe(before);   // the first one really did settle
  });

  test("different keys really do run twice", async () => {
    const id = sid();
    // Guards the whole suite against passing because spins are being swallowed.
    const { orch, calls } = await harness();
    await orch.init({ sid: id }, conn);
    await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "a" }, conn);
    await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "b" }, conn);
    expect(calls()).toBe(2);
  });

  test("no key means no dedupe, as documented", async () => {
    const id = sid();
    const { orch, calls } = await harness();
    await orch.init({ sid: id }, conn);
    await orch.spin({ sid: id, betIndex: 0 }, conn);
    await orch.spin({ sid: id, betIndex: 0 }, conn);
    expect(calls()).toBe(2);
  });

  test("a concurrent retry settles once", async () => {
    const id = sid();
    const { orch, calls } = await harness(30);
    await orch.init({ sid: id }, conn);
    const [a, b] = await Promise.all([
      orch.spin({ sid: id, betIndex: 0, idempotencyKey: "race" }, conn),
      orch.spin({ sid: id, betIndex: 0, idempotencyKey: "race" }, conn),
    ]);
    expect(calls()).toBe(1);
    expect(a).toEqual(b);
  });

  test("the same token on a different call is not confused with the spin", async () => {
    const id = sid();
    // A client reusing one token across call types must not collapse a spin
    // and a close into each other, which is what the phase tag prevents.
    const { orch, calls } = await harness();
    await orch.init({ sid: id }, conn);
    await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "shared" }, conn);
    await expect(orch.closeRound({ sid: id, idempotencyKey: "shared" }, conn))
      .rejects.toThrow();          // no round open - it did NOT return the spin
    expect(calls()).toBe(1);
  });

  test("a failed spin stays retryable", async () => {
    const id = sid();
    const { orch } = await harness();
    await orch.init({ sid: id }, conn);
    // betIndex out of range fails validation.
    await expect(orch.spin({ sid: id, betIndex: 99, idempotencyKey: "t" }, conn)).rejects.toThrow();
    // Same token, now valid: must run rather than replay the error.
    const ok = await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "t" }, conn);
    expect(ok.multiplier).toBe(2);
  });

  test("disabling it restores the old behaviour", async () => {
    const id = sid();
    const platform = new MockPlatform({ startingBalance: 100_000 });
    await platform.connect();
    const { math, calls } = counterMath();
    const orch = createOrchestrator({
      manifest: defineGame({
        id: "off", declaredRtp: 1, defaultMode: "default",
        modes: { default: { math, stakeMultiplier: 1 } },
      }),
      platform,
      requestCache: false,
    });
    await orch.init({ sid: id }, conn);
    await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "k" }, conn);
    await orch.spin({ sid: id, betIndex: 0, idempotencyKey: "k" }, conn);
    expect(calls()).toBe(2);
  });
});
