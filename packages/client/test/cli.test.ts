// The CLI, run as a real subprocess against a real server.
//
// Driving it in-process would test the functions and miss the thing that
// actually breaks: argument parsing, exit codes, and the printed lines people
// grep for in CI. So this spawns the binary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, binaryTransport, withDeferredClose, type ServerHandle } from "@open-rgs/core";
import { MockPlatform } from "@open-rgs/platform-mock";
import { defineGame, type ComplexMath, type SimpleMath } from "@open-rgs/contract";

const PORT = 18291;
const URL = `ws://localhost:${PORT}/wss`;
const CLI = new globalThis.URL("../src/cli.ts", import.meta.url).pathname;

const slot: SimpleMath = {
  kind: "simple", name: "cli", version: "1.0.0", rtp: 1,
  play: () => ({
    multiplier: 2,
    ops: [
      { kind: "board", shape: [2, 2], cells: ["A", "A", "B", "B"] },
      { kind: "win", symbol: "A", count: 2, amount: 2, cells: [0, 1] },
    ],
    type: "win",
  }),
};

const gamble: ComplexMath = {
  kind: "complex", name: "g", version: "1.0.0", rtp: 1,
  open: () => ({ state: "0", ops: [], awaiting: { type: "pick", options: ["a"] } }),
  step: (s) => {
    const n = Number(s) + 1;
    return { state: String(n), ops: [], ...(n >= 2 ? {} : { awaiting: { type: "pick", options: ["a"] } }) };
  },
  isTerminal: (s) => Number(s) >= 2,
  close: () => ({ multiplier: 3, ops: [{ kind: "award", amount: 3 }], type: "win" }),
};

let server: ServerHandle;

beforeAll(async () => {
  server = await createServer({
    manifest: defineGame({
      id: "cli", declaredRtp: 1, defaultMode: "default",
      modes: {
        default:  { math: slot, stakeMultiplier: 1 },
        gamble:   { math: gamble, stakeMultiplier: 1 },
        deferred: { math: withDeferredClose(slot, { prompt: "Collect" }), stakeMultiplier: 1 },
      },
    }),
    platform: new MockPlatform({ startingBalance: 1_000_000 }),
    transport: binaryTransport({ port: PORT }),
    installSignalHandlers: false,
  });
});

afterAll(async () => { await server.stop(); });

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, out: out + err };
}

let n = 0;
const sid = () => `cli-${++n}-${Date.now()}`;

describe("open-rgs-play", () => {
  test("no url is a usage error, not a crash", async () => {
    const r = await run();
    expect(r.code).toBe(2);
    expect(r.out).toContain("usage: open-rgs-play");
  });

  test("plays a simple round and prints a transcript", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("#1 simple 1 step(s)  2x");
    expect(r.out).toContain("board [2,2] A A B B");
    expect(r.out).toContain("win A x2 = 2");
  });

  test("plays a complex round without being told it is complex", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "1", "--mode", "gamble");
    expect(r.code).toBe(0);
    expect(r.out).toContain("#1 complex");
    expect(r.out).toContain("  award 3");
  });

  test("a multi-round run summarises rather than dumping transcripts", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "3");
    expect(r.code).toBe(0);
    expect(r.out).toContain("3 rounds  total 6x  mean 2.000x");
    expect(r.out).not.toContain("board [2,2]");
  });

  test("--retry-token proves the server deduplicates", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "4", "--retry-token");
    expect(r.code).toBe(0);
    expect(r.out).toContain("retries deduplicated");
  });

  test("without --retry-token the balance really does move each round", async () => {
    // Without this, the test above would pass against a CLI that never spins.
    const r = await run(URL, "--sid", sid(), "--rounds", "3");
    const balances = [...r.out.matchAll(/balance (\d+)/g)].map((m) => m[1]);
    expect(new Set(balances).size).toBeGreaterThan(1);
  });

  test("--abandon then --resume walks the replay path", async () => {
    const id = sid();
    const a = await run(URL, "--sid", id, "--mode", "deferred", "--abandon");
    expect(a.code).toBe(0);
    expect(a.out).toContain("awaiting endRound");

    const b = await run(URL, "--sid", id, "--resume", "--rounds", "0");
    expect(b.code).toBe(0);
    expect(b.out).toContain("Unfinished round — watching replay");
    expect(b.out).toContain("#0 complex 2 step(s)  2x");
  });

  test("--resume on a clean session says so instead of failing", async () => {
    const r = await run(URL, "--sid", sid(), "--resume", "--rounds", "0");
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing to resume");
  });

  test("--json emits parseable output and no transcript", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "2", "--json");
    expect(r.code).toBe(0);
    const start = r.out.indexOf("{");
    const parsed = JSON.parse(r.out.slice(start)) as { rounds: { multiplier: number }[] };
    expect(parsed.rounds).toHaveLength(2);
    expect(parsed.rounds[0]!.multiplier).toBe(2);
  });

  test("a bad server answer exits non-zero with the code", async () => {
    const r = await run(URL, "--sid", sid(), "--rounds", "1", "--bet", "99");
    expect(r.code).toBe(1);
    expect(r.out).toContain("INVALID_BET");
  });

  test("a non-numeric --rounds is rejected before connecting", async () => {
    const r = await run(URL, "--rounds", "lots");
    expect(r.code).toBe(2);
    expect(r.out).toContain("--rounds must be a number");
  });
});
