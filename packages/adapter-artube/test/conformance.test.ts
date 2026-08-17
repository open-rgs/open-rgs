// Run the conformance suite against the adapter.
//
// This suite was a declared devDependency of this package for its whole life
// and was never once run. That is the worst state for a test kit to be in: it
// looks covered from the outside and proves nothing.
//
// It cannot point at a real wallet - the suite moves money, opens derived
// sessions and asserts balances, so it only ever belongs against a mock or a
// sandbox. What it CAN do here is run the adapter against a fake Artube server
// speaking the real wire protocol, which is what the fixture below is.
//
// Complex-round checks are skipped on purpose rather than silently passing:
// the Artube Games API is one-shot, so `openComplex` and friends throw. Skipping
// records that as a known limitation instead of pretending it works.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runConformance } from "@open-rgs/adapter-test-kit";
import { ArtubeAdapter } from "../src/index.js";

/** Minimal Artube server: handshake, SessionInfo, PlayRound, nothing else.
 *  Balances are per session so the suite's derived sessions stay independent. */
function fakeArtube() {
  const balances = new Map<string, number>();
  const known = new Set<string>();
  // Index 2 is 100 on purpose: the conformance fixture uses betIndex 2 with
  // bet 100, and this wire is amount-blind - the wallet derives the stake from
  // its own ladder, so the ladder has to agree with the fixture or every
  // balance assertion is off by the difference.
  const LADDER = [25, 50, 100, 200, 500, 1000];
  const START = 1_000_000;
  let roundSeq = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({
          proto: 1, schema: 1, chan: "control", type: "Welcome",
          id: "w1", op_seq: 0, timestamp: Date.now(),
          payload: { use: { max_schema: 1 } },
        }));
      },
      message(ws, raw): void {
        const msg = JSON.parse(String(raw)) as {
          type: string; id: string; payload?: Record<string, unknown>;
        };
        const reply = (type: string, payload: unknown) =>
          ws.send(JSON.stringify({
            proto: 1, schema: 1, chan: "rpc", type,
            id: `r-${msg.id}`, corr_id: msg.id, op_seq: 0,
            timestamp: Date.now(), payload,
          }));

        if (msg.type === "Hello") return;

        if (msg.type === "SessionInfoRequest") {
          const sid = String(msg.payload?.["session_id"] ?? "s");
          // A session only exists once opened. The conformance suite checks
          // that an unknown session is refused, so this must not auto-create.
          if (!balances.has(sid)) balances.set(sid, START);
          known.add(sid);
          reply("SessionInfoResponse", {
            security_hash: "hash",
            currency: "USD",
            balance: balances.get(sid),
            game_settings: {
              default_bet_index: 0,
              allowed_bets: [100, 200, 500, 1000],
              available_auto_spin_counts: [10, 25, 50],
              rtp_options: [{ rtp: 0.96, game_mode: "default" }],
              locales: ["en"],
            },
          });
          return;
        }

        if (msg.type === "PlayRoundRequest") {
          const p = msg.payload ?? {};
          const sid = String(p["session_id"] ?? "s");
          const err = (code: string, message: string) => ws.send(JSON.stringify({
            proto: 1, schema: 1, chan: "rpc", type: "Error",
            id: `e-${msg.id}`, corr_id: msg.id, op_seq: 0, timestamp: Date.now(),
            payload: { code, message },
          }));
          // A real wallet refuses a session it never opened.
          if (!known.has(sid)) { err("E_SESSION_NOT_FOUND", "unknown session"); return; }

          const betIndex = Number(p["bet_index"] ?? 0);
          const priceMul = Number(p["price_multiplier"] ?? 1);
          const winMul   = Number(p["win_multiplier"] ?? 0);
          const bet = LADDER[betIndex] !== undefined ? LADDER[betIndex]! * priceMul : Number.MAX_SAFE_INTEGER;
          const win = Math.round(bet * winMul);
          const have = balances.get(sid) ?? START;
          if (bet > have) {
            err("E_INSUFFICIENT_FUNDS", "not enough balance");
            return;
          }
          const next = have - bet + win;
          balances.set(sid, next);
          reply("PlayRoundResponse", {
            round_id: `round-${++roundSeq}`,
            balance: next,
            win,
          });
        }
      },
    },
  });

  return { url: `ws://localhost:${server.port}`, stop: () => server.stop(true) };
}

let fake: ReturnType<typeof fakeArtube>;
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

  test("opens a session with a usable bet ladder", async () => {
    const info = await adapter.openSession("conf-session", "conn-1");
    expect(info.balance).toBe(1_000_000);
    expect(info.currency).toBe("USD");
    expect(info.allowedBets.length).toBeGreaterThan(0);
    expect(info.allowedBets[info.defaultBetIndex]).toBeDefined();
  });

  test("a settle moves the balance by exactly win minus bet", async () => {
    await adapter.openSession("conf-money", "conn-2");
    // Index 2 is 100 on this wallet's ladder, and the win is derived wallet-side
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

  test("complex rounds throw rather than silently no-oping", async () => {
    // A one-shot wallet that quietly accepted an open would strand a debit.
    await expect(adapter.openComplex({
      sessionId: "conf-session", roundId: "r", bet: 100,
      betIndex: 0, priceMultiplier: 1,
    } as never)).rejects.toThrow(/not supported/i);
  });

  // Two checks the Artube wire cannot satisfy, allowlisted with the reason
  // rather than papered over in the fake server. Faking a pass here would hide
  // a real integration limitation behind a green suite.
  const WIRE_CANNOT = new Set([
    // PlayRoundRequest carries bet_index and price_multiplier, never an
    // amount. The wallet computes the stake from its own ladder, so the
    // adapter cannot declare an oversized bet and this probe cannot trip it.
    // adapter-test-kit fixes the probe to drive priceMultiplier instead; that
    // fix is on an unmerged branch, so it still fails here.
    "errors.insufficient-funds",
    // PlayRoundRequest has no idempotency field at all, so SettleSimple's
    // idempotencyKey is dropped on the floor. A retried settle is NOT deduped
    // by the wallet. See the README - this is the adapter's biggest known gap.
    "idempotency.duplicate-key",
  ]);

  test("the suite runs, and only the checks this wire cannot express fail", async () => {
    const report = await runConformance(adapter, {
      skipComplex: true,   // one-shot protocol, a real limitation not a gap
      skipEvents: true,    // the fake server pushes none
      fixture: { sessionId: "conf-run" },
      perCheckTimeoutMs: 5_000,
    });
    expect(report.checks.length).toBeGreaterThan(0);
    const unexpected = report.checks
      .filter((c) => c.status === "fail" && !WIRE_CANNOT.has(c.id))
      .map((c) => `${c.id}: ${c.message ?? ""}`);
    expect(unexpected).toEqual([]);
  }, 30_000);

  test("the known-unsupported checks really are still failing", async () => {
    // If the wire gains an idempotency field, or the test kit fix lands, this
    // goes red and the allowlist above must shrink. A stale allowlist is how a
    // suite quietly stops testing.
    const report = await runConformance(adapter, {
      skipComplex: true, skipEvents: true,
      fixture: { sessionId: "conf-stale" }, perCheckTimeoutMs: 5_000,
    });
    const failing = new Set(report.checks.filter((c) => c.status === "fail").map((c) => c.id));
    for (const id of WIRE_CANNOT) expect(failing.has(id)).toBe(true);
  }, 30_000);
});
