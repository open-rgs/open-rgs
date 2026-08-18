// A universal client: drive any open-rgs game without being written against it.
//
// `RgsClient` speaks the wire. This adds the layer above it - the part every
// integration otherwise rewrites: run a round to completion whatever shape it
// is, retry safely, keep a readable log of what happened, and replay an
// unfinished round.
//
// It works on any game. Games emitting the canonical ops from
// `@open-rgs/contract/ops` also get a rendered summary; games emitting their
// own shapes still run, still settle, and still produce a transcript - the ops
// are simply passed through undecoded.
//
// WHAT IT IS FOR: smoke-testing a build, driving an integration against a real
// wallet sandbox, capturing a transcript to diff after a change, and proving a
// deferred-close round survives a disconnect. It is not a game client and has
// no opinion about presentation.

import type {
  CanonicalOp, ClientResponseInit, ClientResponseSpin,
  ClientResponseOpenRound, ClientResponseStepRound, ClientResponseCloseRound,
  PlayerAction,
} from "@open-rgs/contract";
import { canonicalOps, opsTotal } from "@open-rgs/contract/ops";
import { RgsClient, RgsServerError } from "./client.js";

/** One thing that happened, in order. A transcript of these is the artifact a
 *  smoke test diffs and a bug report carries. */
export interface Step {
  readonly at: number;
  readonly call: "init" | "spin" | "open" | "step" | "close";
  /** Idempotency token sent, when one was. */
  readonly key?: string;
  readonly ops: readonly unknown[];
  /** Ops a generic client can render. Subset of `ops`. */
  readonly canonical: readonly CanonicalOp[];
  readonly balance?: number;
  /** Multiple of bet, on the calls that settle. */
  readonly multiplier?: number;
  /** What the round is waiting for, if anything. */
  readonly awaiting?: string;
  readonly error?: { code: string; message: string };
}

export interface RoundResult {
  readonly steps: readonly Step[];
  /** Multiple of bet, from the call that settled. */
  readonly multiplier: number;
  readonly balance: number;
  /** True when the round needed open/step/close rather than a single spin. */
  readonly complex: boolean;
  /** Sum of canonical win and award ops. Compare against `multiplier` to catch
   *  a presentation that disagrees with what was paid. */
  readonly opsTotal: number;
}

export interface UniversalOptions {
  /** Chosen when a round asks for an action. Receives the awaited hint and the
   *  ops so far. Default answers the deferred-close action and otherwise picks
   *  the first offered option, which is enough to walk most games end to end. */
  decide?(awaiting: { type: string; options?: unknown[] }, steps: readonly Step[]): PlayerAction;
  /** Guard against a math bug that never reaches a terminal state. Default 200. */
  maxSteps?: number;
  /** Mint an idempotency token per logical call. The default is a per-instance
   *  random prefix plus a counter, so a retry inside this client reuses its
   *  token (the server answers from cache rather than running the round twice)
   *  while a DIFFERENT client cannot collide with it.
   *
   *  The prefix is the part that matters. The default used to be the counter
   *  alone - `uc-spin-1` - which is unique only within one object's lifetime.
   *  Two clients on the same session inside the server's cache window (a
   *  reconnect, a rerun of a smoke test, two workers) minted identical tokens,
   *  and the server correctly answered the second run from the first run's
   *  cache: the run passed without a single round having executed. */
  keyFor?(call: string, n: number): string;
  /** Retries per call on a transport or platform failure. Default 2. Safe
   *  because every retry carries the same token. */
  retries?: number;
}

const DEFAULT_DECIDE: NonNullable<UniversalOptions["decide"]> = (awaiting) => {
  // A deferred-close round is finished with closeRound, not a step, so any
  // action here would be wrong; the runner never asks in that case.
  const first = awaiting.options?.[0];
  return first === undefined
    ? { type: awaiting.type }
    : { type: awaiting.type, value: first };
};

export class UniversalClient {
  private seq = 0;
  /** Random per instance, so tokens from two clients never coincide. */
  private readonly run = Math.random().toString(36).slice(2, 10);

  constructor(
    private readonly rgs: RgsClient,
    private readonly opts: UniversalOptions = {},
  ) {}

  private key(call: string): string {
    const n = ++this.seq;
    return this.opts.keyFor ? this.opts.keyFor(call, n) : `uc-${this.run}-${call}-${n}`;
  }

  /** Call with retries, reusing one token so a retry is deduplicated by the
   *  server rather than replayed as a second round. */
  private async attempt<T>(key: string, fn: (key: string) => Promise<T>): Promise<T> {
    const retries = this.opts.retries ?? 2;
    let last: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fn(key);
      } catch (e) {
        last = e;
        // A rejection the client caused will reject identically next time.
        // Only transport and platform failures are worth another attempt.
        const code = e instanceof RgsServerError ? e.code : undefined;
        const retryable = code === undefined
          || code === "PLATFORM_UNAVAILABLE"
          || code === "MATH_TIMEOUT"
          || code === "INTERNAL_ERROR";
        if (!retryable || i === retries) throw e;
        await new Promise((r) => setTimeout(r, 50 * (i + 1)));
      }
    }
    throw last;
  }

  private step(
    call: Step["call"],
    key: string | undefined,
    ops: readonly unknown[],
    extra: Partial<Step> = {},
  ): Step {
    return {
      at: Date.now(),
      call,
      ...(key ? { key } : {}),
      ops,
      canonical: canonicalOps(ops),
      ...extra,
    };
  }

  /** Open a session. The response carries a resume block when a previous round
   *  was left unfinished; see {@link resumeIfUnfinished}. */
  async init(sid: string): Promise<ClientResponseInit> {
    return this.attempt(this.key("init"), () => this.rgs.init(sid));
  }

  /**
   * Play one round to completion, whatever shape it is.
   *
   * Tries a simple spin first. A game whose mode is complex answers
   * INVALID_MODE, and the runner switches to open/step/close rather than
   * needing to be told which kind of game it is talking to.
   */
  async playRound(betIndex = 0, mode?: string): Promise<RoundResult> {
    const steps: Step[] = [];

    try {
      const key = this.key("spin");
      const res: ClientResponseSpin = await this.attempt(key, (k) =>
        this.rgs.spin({ betIndex, ...(mode ? { mode } : {}), idempotencyKey: k }));
      steps.push(this.step("spin", key, res.ops, {
        balance: res.balance, multiplier: res.multiplier,
      }));
      return this.finish(steps, res.multiplier, res.balance, false);
    } catch (e) {
      const code = e instanceof RgsServerError ? e.code : undefined;
      if (code !== "INVALID_MODE") throw e;
      // Complex mode. Fall through.
    }

    return this.playComplexRound(betIndex, mode, steps);
  }

  private async playComplexRound(
    betIndex: number,
    mode: string | undefined,
    steps: Step[],
  ): Promise<RoundResult> {
    const openKey = this.key("open");
    const opened: ClientResponseOpenRound = await this.attempt(openKey, (k) =>
      this.rgs.openRound({ betIndex, ...(mode ? { mode } : {}), idempotencyKey: k }));
    steps.push(this.step("open", openKey, opened.ops, { awaiting: opened.awaiting?.type }));

    let awaiting = opened.awaiting;
    const max = this.opts.maxSteps ?? 200;

    // A deferred-close round awaits an end action that closeRound performs, so
    // stepping it would be wrong. Anything else is a real decision.
    while (awaiting && awaiting.type !== "endRound") {
      if (steps.length > max) {
        throw new Error(
          `UniversalClient: round exceeded ${max} steps without reaching a terminal ` +
          `state - the math is not converging, or 'awaiting' is never cleared.`,
        );
      }
      const decide = this.opts.decide ?? DEFAULT_DECIDE;
      const action = decide(awaiting, steps);
      const key = this.key("step");
      const res: ClientResponseStepRound = await this.attempt(key, (k) =>
        this.rgs.stepRound({ action, idempotencyKey: k }));
      steps.push(this.step("step", key, res.ops, { awaiting: res.awaiting?.type }));
      awaiting = res.awaiting;
    }

    const closeKey = this.key("close");
    const closed: ClientResponseCloseRound = await this.attempt(closeKey, (k) =>
      this.rgs.closeRound({ idempotencyKey: k }));
    steps.push(this.step("close", closeKey, closed.ops, {
      balance: closed.balance, multiplier: closed.multiplier,
    }));

    return this.finish(steps, closed.multiplier, closed.balance, true);
  }

  private finish(steps: Step[], multiplier: number, balance: number, complex: boolean): RoundResult {
    return {
      steps,
      multiplier,
      balance,
      complex,
      opsTotal: opsTotal(steps.flatMap((s) => s.ops)),
    };
  }

  /**
   * Finish a round the previous session left open.
   *
   * A deferred-close game answers `init` with a resume block carrying
   * `replay.unfinished`. The ops in that block replay the spin that already
   * happened; the outcome was decided when it opened, so closing now pays
   * exactly what it would have paid then.
   *
   * Returns undefined when there is nothing to resume, so this is safe to call
   * unconditionally after every init.
   */
  async resumeIfUnfinished(init: ClientResponseInit): Promise<RoundResult | undefined> {
    const resume = init.resume;
    if (!resume) return undefined;

    const steps: Step[] = [this.step("open", undefined, resume.ops, {
      awaiting: resume.awaiting?.type,
    })];

    // Mid-decision rounds still need their decisions; only an end-round wait
    // can go straight to close.
    if (resume.awaiting && resume.awaiting.type !== "endRound") {
      return this.playComplexRound(0, undefined, steps).catch(() => {
        throw new Error(
          "UniversalClient: resumed a round that is mid-decision. Drive it with " +
          "stepRound using the game's own actions rather than resuming blindly.",
        );
      });
    }

    const key = this.key("close");
    const closed = await this.attempt(key, (k) => this.rgs.closeRound({ idempotencyKey: k }));
    steps.push(this.step("close", key, closed.ops, {
      balance: closed.balance, multiplier: closed.multiplier,
    }));
    return this.finish(steps, closed.multiplier, closed.balance, true);
  }
}

/** Render a transcript as text. For a test diff, a CI log, or a bug report -
 *  a stable, greppable line per event rather than a pretty picture. */
export function describeRound(r: RoundResult): string {
  const out: string[] = [];
  for (const s of r.steps) {
    out.push(`${s.call}${s.awaiting ? ` awaiting=${s.awaiting}` : ""}`);
    for (const op of s.canonical) {
      switch (op.kind) {
        case "board":
          out.push(`  board [${op.shape.join(",")}] ${op.cells.join(" ")}`);
          break;
        case "win":
          out.push(`  win ${op.symbol} x${op.count} = ${op.amount}` +
            (op.ways ? ` (${op.ways} ways)` : "") +
            (op.line !== undefined ? ` (line ${op.line})` : ""));
          break;
        case "cascade":
          out.push(`  cascade ${op.step} cleared=${op.cleared.length}` +
            (op.multiplier ? ` x${op.multiplier}` : ""));
          break;
        case "respin":
          out.push(`  respin left=${op.left}${op.reset ? " (reset)" : ""}`);
          break;
        case "coin":
          out.push(`  coin @${op.cell} ${op.tier ?? op.amount}` +
            (op.cause ? ` (${op.cause})` : ""));
          break;
        case "award":
          // Collapse only the gap the missing label leaves, not the indent
          // every other line in the transcript shares.
          out.push(`  award ${`${op.label ?? ""} ${op.amount}`.replace(/\s+/g, " ").trim()}`);
          break;
        case "feature":
          out.push(`  feature ${op.name} ${op.phase}${op.count ? ` x${op.count}` : ""}`);
          break;
        case "meter":
          out.push(`  meter ${op.name}=${op.value}${op.max ? `/${op.max}` : ""}`);
          break;
        case "message":
          out.push(`  message ${op.text}`);
          break;
      }
    }
  }
  out.push(`= ${r.multiplier}x  balance ${r.balance}  ops ${r.opsTotal}x`);
  return out.join("\n");
}
