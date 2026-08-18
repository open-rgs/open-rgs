// The universal client, driven against a real server over a real WebSocket.
//
// Three claims worth proving, because each is why this exists rather than
// being hand-rolled per integration:
//   1. It plays a round it was not written for - simple or complex, without
//      being told which.
//   2. A retry is deduplicated, so a flaky connection cannot pay twice.
//   3. A round abandoned mid-flight can be resumed and closed later, paying
//      what the open decided.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, binaryTransport, withDeferredClose, type ServerHandle } from "@open-rgs/core";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type ComplexMath, type SimpleMath } from "@open-rgs/contract";
import { RgsClient } from "../src/client.js";
import { UniversalClient, describeRound } from "../src/universal.js";

/** Simple math emitting the canonical op vocabulary. */
const canonical: SimpleMath = {
  kind: "simple", name: "canon", version: "1.0.0", rtp: 1,
  play: () => ({
    multiplier: 2,
    ops: [
      { kind: "board", shape: [2, 2], cells: ["A", "A", "B", "B"] },
      { kind: "win", symbol: "A", count: 2, amount: 2, cells: [0, 1] },
      { kind: "message", text: "nice" },
      { kind: "something-bespoke", whatever: true },   // passes through undecoded
    ],
    type: "win",
  }),
};

/** A three-step gamble, so the runner has real decisions to make. */
const gamble: ComplexMath = {
  kind: "complex", name: "gamble", version: "1.0.0", rtp: 1,
  open: () => ({
    state: "0",
    ops: [{ kind: "meter", name: "steps", value: 0, max: 3 }],
    awaiting: { type: "pick", options: ["left", "right"] },
  }),
  step: (state) => {
    const n = Number(state) + 1;
    return {
      state: String(n),
      ops: [{ kind: "meter", name: "steps", value: n, max: 3 }],
      ...(n >= 3 ? {} : { awaiting: { type: "pick", options: ["left", "right"] } }),
    };
  },
  isTerminal: (state) => Number(state) >= 3,
  close: (state) => ({
    multiplier: Number(state),
    ops: [{ kind: "award", amount: Number(state), label: "gamble" }],
    type: "win",
  }),
};

let server: ServerHandle;
let url = "";

beforeAll(async () => {
  const platform = new MockPlatform({ startingBalance: 1_000_000 });
  server = await createServer({
    manifest: defineGame({
      id: "universal", declaredRtp: 1, defaultMode: "default",
      modes: {
        default:  { math: canonical, stakeMultiplier: 1 },
        gamble:   { math: gamble, stakeMultiplier: 1 },
        deferred: { math: withDeferredClose(canonical, { prompt: "Collect" }), stakeMultiplier: 1 },
      },
    }),
    platform,
    transport: binaryTransport({ port: 18290 }),
    installSignalHandlers: false,
  });
  url = `ws://localhost:18290/wss`;
});

afterAll(async () => { await server.stop(); });

async function connect(): Promise<{ rgs: RgsClient; uc: UniversalClient }> {
  const rgs = new RgsClient(url);
  await rgs.connect();
  return { rgs, uc: new UniversalClient(rgs) };
}

let n = 0;
const sid = () => `u-${++n}-${Date.now()}`;

describe("plays a round without being told its shape", () => {
  test("a simple round", async () => {
    const { rgs, uc } = await connect();
    const id = sid();
    await uc.init(id);
    const r = await uc.playRound(0);
    expect(r.complex).toBe(false);
    expect(r.multiplier).toBe(2);
    expect(r.steps).toHaveLength(1);
    rgs.disconnect();
  });

  test("a complex round, discovered rather than declared", async () => {
    // It tries a spin, gets INVALID_MODE, and switches to open/step/close.
    const { rgs, uc } = await connect();
    await uc.init(sid());
    const r = await uc.playRound(0, "gamble");
    expect(r.complex).toBe(true);
    expect(r.multiplier).toBe(3);
    expect(r.steps.map((s) => s.call)).toEqual(["open", "step", "step", "step", "close"]);
    rgs.disconnect();
  });

  test("a math that never terminates is cut off rather than hanging", async () => {
    const { rgs } = await connect();
    const uc = new UniversalClient(rgs, { maxSteps: 5 });
    await uc.init(sid());
    // gamble terminates at 3, so raise the bar past it to prove the guard
    // fires rather than the round simply ending.
    const bounded = new UniversalClient(rgs, {
      maxSteps: 1,
      decide: () => ({ type: "pick", value: "left" }),
    });
    await expect(bounded.playRound(0, "gamble")).rejects.toThrow(/exceeded 1 steps/);
    rgs.disconnect();
  });
});

describe("canonical ops are decoded, bespoke ops pass through", () => {
  test("both survive, only canonical are rendered", async () => {
    const { rgs, uc } = await connect();
    await uc.init(sid());
    const r = await uc.playRound(0);
    const step = r.steps[0]!;
    expect(step.ops).toHaveLength(4);
    expect(step.canonical).toHaveLength(3);   // the bespoke one is not decoded
    expect(step.canonical.map((o) => o.kind)).toEqual(["board", "win", "message"]);
    rgs.disconnect();
  });

  test("opsTotal lets a test catch a presentation that disagrees with the payout", async () => {
    const { rgs, uc } = await connect();
    await uc.init(sid());
    const r = await uc.playRound(0);
    expect(r.opsTotal).toBe(r.multiplier);
    rgs.disconnect();
  });

  test("describeRound gives a stable, greppable transcript", async () => {
    const { rgs, uc } = await connect();
    await uc.init(sid());
    const text = describeRound(await uc.playRound(0));
    expect(text).toContain("board [2,2] A A B B");
    expect(text).toContain("win A x2 = 2");
    expect(text).toContain("= 2x");
    rgs.disconnect();
  });
});

describe("a retry cannot pay twice", () => {
  test("the same token replays the first response", async () => {
    const { rgs } = await connect();
    const id = sid();
    const uc = new UniversalClient(rgs, { keyFor: () => "fixed-token" });
    await uc.init(id);
    const a = await uc.playRound(0);
    const b = await uc.playRound(0);
    expect(b.balance).toBe(a.balance);   // no second settle
    rgs.disconnect();
  });

  test("distinct tokens really do play twice", async () => {
    // Without this the test above would pass on a client that never spins.
    const { rgs, uc } = await connect();
    await uc.init(sid());
    const a = await uc.playRound(0);
    const b = await uc.playRound(0);
    expect(b.balance).not.toBe(a.balance);
    rgs.disconnect();
  });
});

describe("an abandoned round is replayed and closed", () => {
  test("resume finishes it and pays what the open decided", async () => {
    const id = sid();

    const first = await connect();
    await first.uc.init(id);
    await first.rgs.openRound({ betIndex: 0, mode: "deferred" });
    first.rgs.disconnect();                       // player closes the tab

    const back = await connect();
    const init = await back.uc.init(id);
    expect(init.resume?.replay?.unfinished).toBe(true);
    expect(init.resume?.replay?.message).toBe("Unfinished round — watching replay");

    const r = await back.uc.resumeIfUnfinished(init);
    expect(r?.multiplier).toBe(2);
    expect(r?.steps.map((s) => s.call)).toEqual(["open", "close"]);
    back.rgs.disconnect();
  });

  test("resumeIfUnfinished is a no-op when nothing is open", async () => {
    const { rgs, uc } = await connect();
    const init = await uc.init(sid());
    expect(await uc.resumeIfUnfinished(init)).toBeUndefined();
    rgs.disconnect();
  });
});

describe("default idempotency tokens", () => {
  test("two clients on the same session do not mint the same tokens", () => {
    // The server caches by (session, token). Identical tokens from a second
    // client would be answered from the first client's cache - a smoke test
    // that "passes" without running a round.
    const keys = (c: UniversalClient) =>
      [1, 2, 3].map(() => (c as unknown as { key(call: string): string }).key("spin"));
    const a = new UniversalClient({} as never);
    const b = new UniversalClient({} as never);
    const ka = keys(a);
    const kb = keys(b);
    expect(new Set([...ka, ...kb]).size).toBe(6);
  });

  test("one client still reuses its own token for a retry of the same call", () => {
    const c = new UniversalClient({} as never);
    const k = (c as unknown as { key(call: string): string }).key("spin");
    expect(k).toMatch(/^uc-[a-z0-9]+-spin-1$/);
  });
});
