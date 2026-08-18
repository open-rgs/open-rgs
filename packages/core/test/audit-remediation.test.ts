// Regressions for the audit findings that were reproduced by running them.
// Each test states the behaviour the audit found, so a revert reads as an
// obvious failure rather than a puzzle.

import { describe, expect, test } from "bun:test";
import { defineGame, type ConnectionMeta, type GameManifest, type PlatformAdapter, type SimpleMath } from "@open-rgs/contract";
import { createOrchestrator, createRequestCache, createServer, restTransport, memoryAuditSink } from "../src/index.js";
import { createRgsMetrics } from "../src/metrics-rgs.js";
import * as sessions from "../src/session.js";

const win2: SimpleMath = { kind: "simple", name: "w", version: "1", rtp: 2, play: () => ({ multiplier: 2, ops: [], type: "win" }) };
const loss: SimpleMath = { kind: "simple", name: "l", version: "1", rtp: 0, play: () => ({ multiplier: 0, ops: [], type: "loss" }) };

function manifestOf(math: SimpleMath): GameManifest {
  return defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", modes: { base: { math, stakeMultiplier: 1 } } });
}
const conn = (id = "c1"): ConnectionMeta => ({ connectionId: id, sessionId: null, demo: false } as ConnectionMeta);

describe("a promo pool drains even when the wallet never mentions it", () => {
  // The contract says the engine counts down locally. It did not: the only
  // write to `remaining` came from an optional receipt field, so a wallet whose
  // wire has no promo echo made a 3-round pool unlimited.
  class SilentWallet implements Partial<PlatformAdapter> {
    settles = 0;
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession(id: string) {
      return {
        sessionId: id, currency: "USD", currencyDecimals: 2, balance: 0,
        allowedBets: [100], defaultBetIndex: 0,
        promo: { id: "camp-1", bet: 100, remaining: 3 },
      };
    }
    async settleSimple() { this.settles++; return { roundId: `r${this.settles}`, balance: 0 }; }
  }

  test("exactly the granted number of rounds is funded", async () => {
    const platform = new SilentWallet() as unknown as PlatformAdapter;
    const orch = createOrchestrator({ manifest: manifestOf(win2), platform });
    const c = conn();
    await orch.init({ sid: "promo-drain-1" }, c);
    await orch.promoAccept({ sid: "promo-drain-1", accept: true }, c);

    const funded: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await orch.spin({ sid: "promo-drain-1", betIndex: 0 }, c).catch(() => undefined);
      if (res?.promo) funded.push(res.promo.remaining);
      else break;
    }
    // three funded rounds, counting down, then the pool is gone
    expect(funded).toEqual([2, 1, 0]);
  });

  test("a wallet that reports its own number still wins", async () => {
    class ReportingWallet extends SilentWallet {
      override async settleSimple() {
        this.settles++;
        // wallet says the pool is bigger than our count would suggest
        return { roundId: `r${this.settles}`, balance: 0, promo: { remaining: 9 } };
      }
    }
    const platform = new ReportingWallet() as unknown as PlatformAdapter;
    const orch = createOrchestrator({ manifest: manifestOf(win2), platform });
    const c = conn();
    await orch.init({ sid: "promo-report-1" }, c);
    await orch.promoAccept({ sid: "promo-report-1", accept: true }, c);
    const res = await orch.spin({ sid: "promo-report-1", betIndex: 0 }, c);
    expect(res.promo?.remaining).toBe(9);
  });
});

describe("the audit log records what happened to the money", () => {
  class FailingCloseWallet implements Partial<PlatformAdapter> {
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession(id: string) {
      return { sessionId: id, currency: "USD", currencyDecimals: 2, balance: 10_000, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple() { throw new Error("unused"); }
    async openComplex() { return { roundId: "round-1", balance: 9_900 }; }
    async closeComplex(): Promise<never> { throw new Error("wallet exploded mid-credit"); }
  }

  test("a credit that fails after the stake was taken is logged as failed-win", async () => {
    const complex = {
      kind: "complex" as const, name: "c", version: "1", rtp: 1,
      open: () => ({ state: "s", ops: [] }),
      step: () => ({ state: "s", ops: [] }),
      isTerminal: () => true,
      close: () => ({ multiplier: 3, ops: [], type: "win" }),
    };
    const manifest = defineGame({
      id: "g", declaredRtp: 1, defaultMode: "base",
      modes: { base: { math: complex, stakeMultiplier: 1 } },
    });
    const sink = memoryAuditSink();
    const platform = new FailingCloseWallet() as unknown as PlatformAdapter;
    const orch = createOrchestrator({
      manifest, platform,
      auditLog: (await import("../src/audit-log.js")).createAuditLog(sink, { chainId: "test-chain" }),
    });
    const c = conn();
    await orch.init({ sid: "audit-failedwin-1" }, c);
    await orch.openRound({ sid: "audit-failedwin-1", betIndex: 0 }, c);
    await expect(orch.closeRound({ sid: "audit-failedwin-1" }, c)).rejects.toThrow();

    const statuses = sink.events.map((e) => e.outcomeStatus);
    expect(statuses).toContain("opened");
    expect(statuses).toContain("failed-win");
    // and the chain is still intact across both
    expect(sink.events.every((e) => e.chainId === "test-chain")).toBe(true);
  });

  test("a bet refused before any money moved is logged as rejected", async () => {
    const sid = "audit-rejected-1";
    class BrokeWallet implements Partial<PlatformAdapter> {
      isHealthy = true;
      diagnostics = {};
      async connect() {}
      disconnect() {}
      onEvent() {}
      async openSession(id: string) {
        return { sessionId: id, currency: "USD", currencyDecimals: 2, balance: 1, allowedBets: [100], defaultBetIndex: 0 };
      }
      async settleSimple() { throw new Error("should never be called"); }
    }
    const sink = memoryAuditSink();
    const orch = createOrchestrator({
      manifest: manifestOf(loss),
      platform: new BrokeWallet() as unknown as PlatformAdapter,
      auditLog: (await import("../src/audit-log.js")).createAuditLog(sink),
    });
    const c = conn();
    await orch.init({ sid }, c);
    await expect(orch.spin({ sid, betIndex: 0 }, c)).rejects.toThrow(/balance/i);
    expect(sink.events.map((e) => e.outcomeStatus)).toEqual(["rejected"]);
  });
});

describe("the active-session gauge counts sessions, not INIT calls", () => {
  class Wallet implements Partial<PlatformAdapter> {
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession(sid: string) {
      return { sessionId: sid, currency: "USD", currencyDecimals: 2, balance: 1000, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple() { return { roundId: "r", balance: 1000 }; }
  }

  test("a player reconnecting five times is one session", async () => {
    const metrics = createRgsMetrics();
    const orch = createOrchestrator({
      manifest: manifestOf(loss),
      platform: new Wallet() as unknown as PlatformAdapter,
      metrics,
    });
    const sid = `gauge-${Date.now()}`;
    for (let i = 0; i < 5; i++) await orch.init({ sid }, conn(`c${i}`));

    const line = metrics.registry.expose().split("\n").find((l) => l.startsWith("rgs_sessions_active"));
    expect(line).toBe(`rgs_sessions_active ${sessions.size()}`);
  });
});

describe("REST discloses exactly what the WebSocket transport discloses", () => {
  class LeakyWallet implements Partial<PlatformAdapter> {
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession() {
      return { sessionId: "s1", currency: "USD", currencyDecimals: 2, balance: 10_000, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple(): Promise<never> {
      throw new Error("wallet 500: https://internal-wallet.corp/v1/settle trace=srv-42 db=pg-prod-3");
    }
  }

  test("an upstream error body does not reach the client", async () => {
    const orch = createOrchestrator({ manifest: manifestOf(loss), platform: new LeakyWallet() as unknown as PlatformAdapter });
    const t = restTransport({ port: 0 });
    const { port } = await t.start(orch);
    try {
      await fetch(`http://localhost:${port}/session`, { method: "POST", body: JSON.stringify({ sid: "rest-leak-1" }) });
      const res = await fetch(`http://localhost:${port}/spin`, { method: "POST", body: JSON.stringify({ sid: "rest-leak-1", betIndex: 0 }) });
      const body = await res.text();
      expect(body).not.toContain("internal-wallet.corp");
      expect(body).not.toContain("pg-prod-3");
      expect(body).toContain("SPIN_FAILED");
      expect(body).toMatch(/ref: [0-9a-f-]{8}/);
    } finally {
      await t.stop();
    }
  });

  test("a client-fixable error still says what is wrong", async () => {
    const orch = createOrchestrator({ manifest: manifestOf(loss), platform: new LeakyWallet() as unknown as PlatformAdapter });
    const t = restTransport({ port: 0 });
    const { port } = await t.start(orch);
    try {
      await fetch(`http://localhost:${port}/session`, { method: "POST", body: JSON.stringify({ sid: "rest-leak-2" }) });
      const res = await fetch(`http://localhost:${port}/spin`, { method: "POST", body: JSON.stringify({ sid: "rest-leak-2", betIndex: 99 }) });
      expect(await res.text()).toContain("betIndex 99 out of range");
    } finally {
      await t.stop();
    }
  });
});

describe("REST has one connection per session, so a policy cannot lock a player out", () => {
  class Wallet implements Partial<PlatformAdapter> {
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession(sid: string) {
      return { sessionId: sid, currency: "USD", currencyDecimals: 2, balance: 1000, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple() { return { roundId: "r", balance: 1000 }; }
  }

  test("repeated /session under reject-new keeps working", async () => {
    const orch = createOrchestrator({
      manifest: manifestOf(loss),
      platform: new Wallet() as unknown as PlatformAdapter,
      concurrencyPolicy: "reject-new",
    });
    const t = restTransport({ port: 0 });
    const { port } = await t.start(orch);
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`http://localhost:${port}/session`, { method: "POST", body: JSON.stringify({ sid: "rest-lockout" }) });
        expect(r.status).toBe(200);
      }
    } finally {
      await t.stop();
    }
  });
});

describe("wire payloads are checked, not cast", () => {
  class Wallet implements Partial<PlatformAdapter> {
    opened: unknown[] = [];
    isHealthy = true;
    diagnostics = {};
    async connect() {}
    disconnect() {}
    onEvent() {}
    async openSession(sid: string) {
      this.opened.push(sid);
      return { sessionId: sid, currency: "USD", currencyDecimals: 2, balance: 1000, allowedBets: [100], defaultBetIndex: 0 };
    }
    async settleSimple() { return { roundId: "r", balance: 1000 }; }
  }

  test("a non-string sid is refused before it reaches the wallet", async () => {
    const wallet = new Wallet();
    const orch = createOrchestrator({ manifest: manifestOf(loss), platform: wallet as unknown as PlatformAdapter });
    const t = restTransport({ port: 0 });
    const { port } = await t.start(orch);
    try {
      const res = await fetch(`http://localhost:${port}/session`, { method: "POST", body: JSON.stringify({ sid: 12345 }) });
      expect(res.status).toBe(400);
      expect(wallet.opened).toEqual([]);
    } finally {
      await t.stop();
    }
  });

  test("params must be an object, since it is handed to the math", async () => {
    const orch = createOrchestrator({ manifest: manifestOf(loss), platform: new Wallet() as unknown as PlatformAdapter });
    const t = restTransport({ port: 0 });
    const { port } = await t.start(orch);
    try {
      await fetch(`http://localhost:${port}/session`, { method: "POST", body: JSON.stringify({ sid: "params-1" }) });
      const res = await fetch(`http://localhost:${port}/spin`, {
        method: "POST",
        body: JSON.stringify({ sid: "params-1", params: "not-an-object" }),
      });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("params must be an object");
    } finally {
      await t.stop();
    }
  });
});

describe("the request cache keys cannot collide across sessions", () => {
  test("a session id containing the separator character stays separate", async () => {
    const cache = createRequestCache({});
    const victim = await cache.run("player-a", "spin\n7", async () => "victim-response");
    const attacker = await cache.run("player-a\nspin", "7", async () => "attacker-response");
    expect(victim).toBe("victim-response");
    expect(attacker).toBe("attacker-response");
  });

  test("clearing one session does not clear a similarly-named one", async () => {
    const cache = createRequestCache({});
    await cache.run("player-a extra", "k", async () => 1);
    cache.clearScope("player-a");
    expect(cache.size).toBe(1);
  });
});
