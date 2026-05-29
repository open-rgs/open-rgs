// M14  - the cookbook told adapters to emit "campaignGranted", but the
// contract event is "promoGranted"; an unknown event type was silently
// dropped, so free-round grants vanished. Verify the canonical name is
// applied and an unknown type is dropped without throwing (now also logged).

import { describe, expect, test } from "bun:test";
import { createOrchestrator, session } from "../src/index.js";
import {
  defineGame,
  type PlatformAdapter, type SessionInfo, type RoundReceipt, type SimpleMath,
  type ConnectionMeta, type PlatformEvent,
} from "@open-rgs/contract";

class EventPlatform implements PlatformAdapter {
  isHealthy = true;
  diagnostics = {};
  private handler: ((e: PlatformEvent) => void) | undefined;
  async connect() {}
  disconnect() {}
  async openSession(sessionId: string): Promise<SessionInfo> {
    return { sessionId, currency: "USD", currencyDecimals: 2, balance: 1000, allowedBets: [100], defaultBetIndex: 0 };
  }
  async settleSimple(): Promise<RoundReceipt> { return { roundId: "s", balance: 1000 }; }
  async openComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: 1000 }; }
  async closeComplex(): Promise<RoundReceipt> { return { roundId: "r", balance: 1000 }; }
  onEvent(h: (e: PlatformEvent) => void) { this.handler = h; }
  emit(e: unknown) { this.handler?.(e as PlatformEvent); }
}

const math: SimpleMath = { kind: "simple", name: "m", version: "1", rtp: 1, play: () => ({ multiplier: 0, ops: [], type: "x" }) };

function setup() {
  const platform = new EventPlatform();
  const manifest = defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", modes: { base: { math, stakeMultiplier: 1 } } });
  const orch = createOrchestrator({ manifest, platform });
  const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };
  return { orch, platform, conn };
}

describe("platform event handling (M14)", () => {
  test("the canonical promoGranted event applies the pool", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "evt-promo" }, conn);
    platform.emit({ type: "promoGranted", sessionId: "evt-promo", promo: { id: "p1", bet: 100, remaining: 5 } });
    expect(session.get("evt-promo")?.promo?.remaining).toBe(5);
  });

  test("an unknown event type (legacy campaignGranted) is dropped, not thrown", async () => {
    const { orch, platform, conn } = setup();
    await orch.init({ sid: "evt-unknown" }, conn);
    expect(() => platform.emit({ type: "campaignGranted", sessionId: "evt-unknown", promo: { id: "x", bet: 100, remaining: 9 } })).not.toThrow();
    // No promo applied (the legacy name isn't recognised).
    expect(session.get("evt-unknown")?.promo).toBeUndefined();
  });
});
