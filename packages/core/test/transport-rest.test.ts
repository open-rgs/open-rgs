// REST transport, driven end to end against a real orchestrator and the
// in-memory wallet - so these exercise the actual money path, not a stub.
//
// The deferred-close round is the interesting case: spin, walk away, come back,
// see the replay flag, then end it. That sequence is the whole feature.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createOrchestrator, UNFINISHED_ROUND_MESSAGE } from "../src/orchestrator.js";
import { restTransport } from "../src/transport-rest.js";
import { withDeferredClose } from "../src/deferred-close.js";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type SimpleMath } from "@open-rgs/contract";

const alwaysWins: SimpleMath = {
  kind: "simple", name: "w", version: "1.0.0", rtp: 1,
  play: () => ({ multiplier: 2, ops: [{ kind: "spin", mult: 2 }], type: "win" }),
};

let port = 0;
let transport: ReturnType<typeof restTransport>;
let platform: MockPlatform;

beforeAll(async () => {
  platform = new MockPlatform({ startingBalance: 100_000 });
  await platform.connect();
  const orch = createOrchestrator({
    manifest: defineGame({
      id: "rest-test", declaredRtp: 1, defaultMode: "default",
      modes: {
        default:  { math: alwaysWins, stakeMultiplier: 1 },
        deferred: { math: withDeferredClose(alwaysWins, { prompt: "Collect" }), stakeMultiplier: 1 },
      },
    }),
    platform,
  });
  transport = restTransport({ maxBodyBytes: 2048 });
  ({ port } = await transport.start(orch));
});

afterAll(async () => { await transport.stop(); });

const post = async (path: string, body: unknown) => {
  const res = await fetch(`http://localhost:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, never> };
};

let n = 0;
const freshSid = () => `sid-${++n}-${Date.now()}`;

describe("routing and errors", () => {
  test("healthz answers without a session", async () => {
    const res = await fetch(`http://localhost:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  test("an unknown route is a 400, not a 404 page", async () => {
    const { status, json } = await post("/nope", {});
    expect(status).toBe(400);
    expect(json["error"]!["code"]).toBe("INVALID_FORMAT");
  });

  test("GET on an action route is refused", async () => {
    const res = await fetch(`http://localhost:${port}/spin`);
    expect(res.status).toBe(400);
  });

  test("malformed JSON is a decode error", async () => {
    const res = await fetch(`http://localhost:${port}/spin`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, never>)["error"]!["code"]).toBe("DECODE_ERROR");
  });

  test("a JSON array body is refused - the handlers expect an object", async () => {
    const res = await fetch(`http://localhost:${port}/spin`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "[1,2,3]",
    });
    expect(res.status).toBe(400);
  });

  test("an oversized body is refused before it reaches math", async () => {
    const res = await fetch(`http://localhost:${port}/spin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sid: "x", params: { pad: "a".repeat(4000) } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, never>)["error"]!["message"]).toMatch(/exceeds/);
  });

  test("a missing session maps to 401, not 500", async () => {
    const { status, json } = await post("/spin", {});
    expect(status).toBe(401);
    expect(json["error"]!["code"]).toBe("MISSING_SESSION");
  });

  test("an unknown session maps to 404", async () => {
    const { status } = await post("/spin", { sid: "never-initialised" });
    expect(status).toBe(404);
  });
});

describe("a simple round over REST", () => {
  test("init then spin moves money", async () => {
    const sid = freshSid();
    const init = await post("/session", { sid });
    expect(init.status).toBe(200);
    expect(init.json["balance"]).toBe(100_000);

    const spin = await post("/spin", { sid, betIndex: 0 });
    expect(spin.status).toBe(200);
    expect(spin.json["multiplier"]).toBe(2);
    expect(spin.json["win"]).toBeGreaterThan(0);
  });
});

describe("deferred close: the explicit end round", () => {
  test("opening leaves the round unfinished and awaiting the end action", async () => {
    const sid = freshSid();
    await post("/session", { sid });

    const open = await post("/round/open", { sid, mode: "deferred", betIndex: 0 });
    expect(open.status).toBe(200);
    expect(open.json["awaiting"]!["type"]).toBe("endRound");
    // The client can render the whole spin already.
    expect(open.json["ops"]).toHaveLength(1);
  });

  test("a spin is refused while the round is still open", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    await post("/round/open", { sid, mode: "deferred", betIndex: 0 });

    const spin = await post("/spin", { sid, betIndex: 0 });
    expect(spin.status).toBe(409);
    expect(spin.json["error"]!["code"]).toBe("ROUND_ALREADY_OPEN");
  });

  test("re-initialising resumes with the replay flag and the canonical message", async () => {
    // This is the whole feature: the player closed the tab and came back.
    const sid = freshSid();
    await post("/session", { sid });
    await post("/round/open", { sid, mode: "deferred", betIndex: 0 });

    const back = await post("/session", { sid });
    expect(back.status).toBe(200);
    const resume = back.json["resume"]! as Record<string, never>;
    expect(resume["replay"]!["unfinished"]).toBe(true);
    expect(resume["replay"]!["message"]).toBe(UNFINISHED_ROUND_MESSAGE);
    expect(resume["replay"]!["message"]).toBe("Unfinished round — watching replay");
    // ops replay the spin that already happened
    expect(resume["ops"]).toHaveLength(1);
  });

  test("ending the round pays what the open decided", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    await post("/round/open", { sid, mode: "deferred", betIndex: 0 });

    const end = await post("/round/end", { sid });
    expect(end.status).toBe(200);
    expect(end.json["multiplier"]).toBe(2);
    expect(end.json["win"]).toBeGreaterThan(0);
  });

  test("ending twice is refused - there is no round left", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    await post("/round/open", { sid, mode: "deferred", betIndex: 0 });
    await post("/round/end", { sid });

    const again = await post("/round/end", { sid });
    expect(again.status).toBe(409);
    expect(again.json["error"]!["code"]).toBe("NO_ROUND_OPEN");
  });

  test("after ending, a normal spin works again", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    await post("/round/open", { sid, mode: "deferred", betIndex: 0 });
    await post("/round/end", { sid });

    expect((await post("/spin", { sid, betIndex: 0 })).status).toBe(200);
  });

  test("a resumed round can still be ended, and pays the same", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    const open = await post("/round/open", { sid, mode: "deferred", betIndex: 0 });
    await post("/session", { sid });                    // reconnect
    const end = await post("/round/end", { sid });
    expect(end.json["multiplier"]).toBe(open.json["ops"] ? 2 : 2);
    expect(end.status).toBe(200);
  });

  test("an ordinary mode carries no replay flag", async () => {
    const sid = freshSid();
    await post("/session", { sid });
    await post("/spin", { sid, betIndex: 0 });
    const back = await post("/session", { sid });
    expect(back.json["resume"]).toBeUndefined();
  });
});

describe("the transport declines what it cannot do", () => {
  test("closeConnection is absent, so kick-old degrades visibly", () => {
    // Implementing it as a no-op would let the concurrency policy silently do
    // nothing. Leaving it off makes createServer warn at boot instead.
    expect(transport.closeConnection).toBeUndefined();
  });
});
