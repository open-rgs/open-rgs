#!/usr/bin/env bun
// open-rgs-play  - point it at a running open-rgs server and it plays.
//
// The smallest useful thing you can run against a server you just deployed:
// no game code, no fixtures, no knowledge of which modes are simple and which
// are complex. It connects, plays rounds, and prints what happened.
//
// Usage:
//   bunx open-rgs-play <url> [--sid ID] [--rounds N] [--bet N] [--mode NAME]
//                            [--retry-token] [--abandon] [--resume]
//                            [--json] [--quiet]
//
// Examples:
//   bunx open-rgs-play ws://localhost:8080/wss
//   bunx open-rgs-play ws://localhost:8080/wss --rounds 20 --mode bonus
//   bunx open-rgs-play ws://localhost:8080/wss --sid s1 --mode deferred --abandon
//   bunx open-rgs-play ws://localhost:8080/wss --sid s1 --resume
//   bunx open-rgs-play ws://localhost:8080/wss --retry-token
//
// --retry-token sends every round with the SAME idempotency token, which is
// the fastest way to see whether retries are being deduplicated: the balance
// must move exactly once no matter how many rounds you ask for.
//
// --abandon opens a round and disconnects without closing it, which is what a
// player closing the tab mid-presentation does. Pair it with --resume on the
// same --sid to exercise the replay path end to end:
//
//   open-rgs-play <url> --sid s1 --mode deferred --abandon
//   open-rgs-play <url> --sid s1 --resume
//
// --resume finishes a round a previous session left open (deferred close)
// before playing anything new, and reports the replay message the server sent.
//
// Exit code is 1 on any failure, so this drops straight into CI as a smoke
// test.

import { RgsClient, RgsServerError } from "./client.js";
import { UniversalClient, describeRound, type RoundResult } from "./universal.js";

interface Args {
  url: string;
  sid: string;
  rounds: number;
  bet: number;
  mode?: string;
  retryToken: boolean;
  abandon: boolean;
  resume: boolean;
  json: boolean;
  quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags.set(name, next); i++; }
    else flags.set(name, true);
  }

  const url = positional[0];
  if (!url) {
    console.error(
      "usage: open-rgs-play <url> [--sid ID] [--rounds N] [--bet N] [--mode NAME]\n" +
      "                          [--retry-token] [--abandon] [--resume]\n" +
      "                          [--json] [--quiet]",
    );
    process.exit(2);
  }

  const num = (k: string, dflt: number) => {
    const v = flags.get(k);
    if (v === undefined || v === true) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) { console.error(`--${k} must be a number, got ${v}`); process.exit(2); }
    return n;
  };
  const str = (k: string) => {
    const v = flags.get(k);
    return typeof v === "string" ? v : undefined;
  };

  return {
    url,
    sid: str("sid") ?? `play-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    rounds: num("rounds", 1),
    bet: num("bet", 0),
    ...(str("mode") ? { mode: str("mode")! } : {}),
    retryToken: flags.get("retry-token") === true,
    abandon: flags.get("abandon") === true,
    resume: flags.get("resume") === true,
    json: flags.get("json") === true,
    quiet: flags.get("quiet") === true,
  };
}

/** One line per round when not printing full transcripts, so a long run stays
 *  readable and a CI log stays greppable. */
function summarise(i: number, r: RoundResult): string {
  const shape = r.complex ? "complex" : "simple";
  const drift = r.opsTotal === r.multiplier ? "" : `  OPS-MISMATCH ops=${r.opsTotal}x`;
  return `#${i} ${shape} ${r.steps.length} step(s)  ${r.multiplier}x  balance ${r.balance}${drift}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = args.quiet ? () => {} : (s: string) => console.log(s);

  const rgs = new RgsClient(args.url);
  await rgs.connect();

  const uc = new UniversalClient(rgs, {
    // One fixed token across every round is the whole point of --retry-token:
    // the server should treat rounds 2..N as resends of round 1.
    ...(args.retryToken ? { keyFor: () => "open-rgs-play-fixed-token" } : {}),
  });

  const init = await uc.init(args.sid);
  out(`session ${args.sid}  balance ${init.balance}  bets ${init.allowedBets?.length ?? "?"}`);

  if (args.abandon) {
    // Open and walk away. No close, so the round stays outstanding and the
    // next init on this sid reports it as unfinished.
    const opened = await rgs.openRound({
      betIndex: args.bet,
      ...(args.mode ? { mode: args.mode } : {}),
      idempotencyKey: `abandon-${args.sid}`,
    });
    out(`opened round, awaiting ${opened.awaiting?.type ?? "nothing"}  balance ${opened.balance}`);
    out(`abandoned. resume it with: --sid ${args.sid} --resume`);
    rgs.disconnect();
    return;
  }

  const rounds: RoundResult[] = [];
  let resumed: RoundResult | undefined;

  if (args.resume) {
    const replay = init.resume?.replay;
    if (replay?.unfinished) out(`resuming: ${replay.message}`);
    resumed = await uc.resumeIfUnfinished(init);
    if (!resumed) out("nothing to resume");
    else {
      out(summarise(0, resumed));
      if (!args.json) out(describeRound(resumed));
    }
  }

  for (let i = 1; i <= args.rounds; i++) {
    const r = await uc.playRound(args.bet, args.mode);
    rounds.push(r);
    out(summarise(i, r));
    // A single round is usually being inspected; a run of them is usually
    // being watched for drift, and full transcripts would bury it.
    if (!args.json && args.rounds === 1) out(describeRound(r));
  }

  rgs.disconnect();

  if (args.json) {
    console.log(JSON.stringify({
      sid: args.sid,
      startingBalance: init.balance,
      ...(resumed ? { resumed } : {}),
      rounds,
    }, null, 2));
    return;
  }

  if (rounds.length > 1) {
    const total = rounds.reduce((a, r) => a + r.multiplier, 0);
    const first = rounds[0]!;
    const last = rounds[rounds.length - 1]!;
    out(`\n${rounds.length} rounds  total ${total}x  mean ${(total / rounds.length).toFixed(3)}x`);
    if (args.retryToken) {
      const deduped = rounds.every((r) => r.balance === first.balance);
      out(deduped
        ? `retries deduplicated: balance held at ${first.balance} across all ${rounds.length} calls`
        : `NOT deduplicated: balance moved ${first.balance} to ${last.balance}`);
      if (!deduped) process.exitCode = 1;
    }
  }
}

main().catch((e: unknown) => {
  if (e instanceof RgsServerError) console.error(`${e.code}: ${e.message}`);
  else console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
