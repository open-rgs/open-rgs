// What a client is told when INIT fails.
//
// The wallet refusing a session is the single most common integration
// failure, and it was also the least legible one: platform.openSession was
// the one platform call init did not run through translate(), so an upstream
// refusal arrived as a bare Error, became INTERNAL_ERROR at the transport,
// and reached the client as "internal error (ref: ...)" with the actual
// reason visible only in the pod's logs.

import { describe, expect, test } from "bun:test";
import { createOrchestrator } from "../src/index.js";
import {
  defineGame, RGSError,
  type ConnectionMeta, type PlatformAdapter, type PlatformEvent,
  type RoundReceipt, type SessionInfo, type SimpleMath,
} from "@open-rgs/contract";

function platformThatRefuses(message: string): PlatformAdapter {
  return {
    isHealthy: true,
    diagnostics: {},
    async connect() {},
    disconnect() {},
    async openSession(): Promise<SessionInfo> { throw new Error(message); },
    async settleSimple(): Promise<RoundReceipt> { throw new Error("unused"); },
    async openComplex(): Promise<RoundReceipt> { throw new Error("unused"); },
    async closeComplex(): Promise<RoundReceipt> { throw new Error("unused"); },
    onEvent(_h: (e: PlatformEvent) => void) {},
  };
}

const math: SimpleMath = {
  kind: "simple", name: "m", version: "1", rtp: 1,
  play: () => ({ multiplier: 0, ops: [], type: "loss" }),
};

function orchestratorWith(platform: PlatformAdapter) {
  return createOrchestrator({
    manifest: defineGame({ id: "g", declaredRtp: 1, defaultMode: "base", modes: { base: { math, stakeMultiplier: 1 } } }),
    platform,
  });
}

const conn: ConnectionMeta = { connectionId: "c1", sessionId: null, demo: false };

describe("init failures", () => {
  test("a session the wallet does not recognise is SESSION_INVALID, not an opaque internal error", async () => {
    const orch = orchestratorWith(platformThatRefuses("Artube SessionInvalid: The session is invalid or cannot be retrieved"));
    try {
      await orch.init({ sid: "gone" }, conn);
      throw new Error("init should have failed");
    } catch (e) {
      expect(e).toBeInstanceOf(RGSError);
      expect((e as RGSError).code).toBe("SESSION_INVALID");
      // And the reason survives, because SESSION_INVALID is not an opaque code.
      expect((e as RGSError).message).toMatch(/SessionInvalid/);
    }
  });

  test("anything else still fails closed as INIT_FAILED", async () => {
    const orch = orchestratorWith(platformThatRefuses("socket hung up"));
    try {
      await orch.init({ sid: "s" }, conn);
      throw new Error("init should have failed");
    } catch (e) {
      expect((e as RGSError).code).toBe("INIT_FAILED");
    }
  });
});
