// Demo sessions, kept in this process.
//
// Artube's demo mode has no requests of its own: `PlayRound`, `OpenRound`,
// `UpdateRoundState` and `CloseRound` look identical either way, and the
// platform does not persist a demo round. A session is a demo session when
// its **currency is null** - that is the whole marker - and from there the
// backend is expected to track the virtual balance itself, for as long as the
// session lives.
//
// So: wrap the wallet. A demo session is answered from memory and never
// reaches the wire; a real one passes straight through, untouched. The
// decision is per session and is made once, from what the wallet said when
// the session opened.
//
// What this deliberately does NOT do:
//
//   Persist anything. A demo balance lives as long as the process, and a
//   demo carry with it. That is the platform's own behaviour - "demo rounds
//   are not persisted the way real-money rounds are, so a reconnect may not
//   restore an in-progress demo round" - and pretending otherwise would mean
//   inventing durability for play money while the real thing goes through a
//   wallet.
//
//   Guess. A session is demo because the wallet returned no currency for it,
//   never because of a session-id prefix or a config flag. Getting that
//   backwards is how play money reaches a real balance.

import type {
  CarryState, CloseComplex, OpenComplex, PlatformAdapter, PlatformEvent,
  RoundReceipt, SessionInfo, SettleSimple, UpdateComplex,
} from "@open-rgs/contract";
import { createLogger, type Logger } from "@open-rgs/log";
import pkg from "../package.json" with { type: "json" };

/** A read-only look at what this process is storing for a demo session. */
export interface DemoSessionView {
  balance: number;
  rounds: number;
  carry?: CarryState;
  mathVersion?: string;
  nextMode?: string;
  openRound?: DemoRound;
  lastRound?: DemoRound;
}

/** The adapter returned by {@link withDemoSessions}, which can also report
 *  what it is holding for a demo session. */
export interface DemoCapableAdapter extends PlatformAdapter {
  demoSessionFor(sessionId: string): DemoSessionView | undefined;
}

export interface DemoSessionsOptions {
  /** Play-money balance a demo session starts with, in the currency's
   *  minimal unit. Default 1_000_000 (10,000.00 at 2 decimals). */
  startingBalance?: number;
  logger?: Logger;
}

/** What the Games API would have stored about one round. Kept here instead. */
export interface DemoRound {
  roundId: string;
  betIndex: number;
  priceMultiplier: number;
  bet: number;
  /** The round's state, as the wallet's `round_state` would hold it: written
   *  at open, replaced by every update, final at close. */
  state: string;
  stateVersion?: string;
  /** Round-operation counter, the demo equivalent of `round_version`. */
  version: number;
  winMultiplier?: number;
  win?: number;
  startedAt: string;
  finishedAt?: string;
}

interface DemoSession {
  balance: number;
  carry?: CarryState;
  nextMode?: string;
  mathVersion?: string;
  /** The open complex round, if any. Demo rounds are this process's own, so
   *  the id is generated here. */
  open?: DemoRound;
  /** The last round to finish, the demo equivalent of `last_round`. */
  lastRound?: DemoRound;
  rounds: number;
}

/**
 * Serve demo sessions from memory, pass everything else to `inner`.
 *
 * ```ts
 * const platform = withDemoSessions(new ArtubeAdapter({ ... }), {
 *   startingBalance: 1_000_000,
 * });
 * ```
 *
 * The returned adapter is a `PlatformAdapter` like any other; nothing above
 * it needs to know which kind of session it is looking at.
 */
export function withDemoSessions(inner: PlatformAdapter, opts: DemoSessionsOptions = {}): DemoCapableAdapter {
  const startingBalance = opts.startingBalance ?? 1_000_000;
  const log = opts.logger ?? createLogger({ service: "open-rgs-adapter-artube-demo", version: pkg.version });
  const demo = new Map<string, DemoSession>();

  const isDemo = (sessionId: string): boolean => demo.has(sessionId);

  const receipt = (s: DemoSession, roundId: string): RoundReceipt => ({ roundId, balance: s.balance });

  const wrapped: PlatformAdapter = {
    connect: () => inner.connect(),
    disconnect: () => inner.disconnect(),
    get isHealthy() { return inner.isHealthy; },
    get diagnostics() {
      return { ...inner.diagnostics, demo_sessions: demo.size };
    },

    async openSession(sessionId: string, connectionId: string): Promise<SessionInfo> {
      // Always ask the wallet: it owns the bet ladder, the promo pool and the
      // answer to "is this a demo session at all".
      const info = await inner.openSession(sessionId, connectionId);
      if (info.currency !== "" && info.currency !== null && info.currency !== undefined) {
        // A session that stops being demo cannot keep a demo balance.
        if (demo.delete(sessionId)) {
          log.warn("Demo session came back with a currency, dropping its play money", {
            "event.category": "artube",
            "event.action":   "demo_session_became_real",
            "artube.session_id": sessionId,
          });
        }
        return info;
      }

      let s = demo.get(sessionId);
      if (!s) {
        s = { balance: startingBalance, rounds: 0 };
        demo.set(sessionId, s);
        log.info("Demo session opened, balance served from memory", {
          "event.category": "artube",
          "event.action":   "demo_session_start",
          "artube.session_id": sessionId,
          "artube.demo_balance": s.balance,
        });
      }

      // The wallet's own view of everything that is not money: the ladder, the
      // default bet, the promo pool. Only the balance and the carry are ours.
      const out: SessionInfo = {
        ...info,
        balance: s.balance,
      };
      if (s.carry !== undefined) out.carry = s.carry;
      else delete out.carry;
      if (s.mathVersion !== undefined) out.mathVersion = s.mathVersion;
      else delete out.mathVersion;
      if (s.nextMode !== undefined) out.nextMode = s.nextMode;
      else delete out.nextMode;
      return out;
    },

    async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
      const s = demo.get(req.sessionId);
      if (!s) return inner.settleSimple(req);
      s.balance = s.balance - req.bet + req.win;
      s.carry = req.roundState;
      s.mathVersion = req.mathVersion;
      s.nextMode = req.nextMode;
      s.rounds += 1;
      const roundId = `demo-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      s.lastRound = {
        roundId,
        betIndex: req.betIndex,
        priceMultiplier: req.priceMultiplier,
        bet: req.bet,
        state: req.roundState,
        ...(req.mathVersion !== undefined ? { stateVersion: req.mathVersion } : {}),
        version: 0,
        winMultiplier: req.multiplier,
        win: req.win,
        startedAt: now,
        finishedAt: now,
      };
      return receipt(s, roundId);
    },

    async openComplex(req: OpenComplex): Promise<RoundReceipt> {
      const s = demo.get(req.sessionId);
      if (!s) return inner.openComplex(req);
      if (s.open) {
        // Same refusal the wallet gives, for the same reason: one open round
        // per session, and a second open would strand the first one's stake.
        throw new Error("demo: a round is already open on this session");
      }
      s.balance -= req.bet;
      const roundId = `demo-${crypto.randomUUID()}`;
      s.open = {
        roundId,
        betIndex: req.betIndex,
        priceMultiplier: req.priceMultiplier,
        bet: req.bet,
        state: req.initialState,
        ...(req.mathVersion !== undefined ? { stateVersion: req.mathVersion } : {}),
        version: 0,
        startedAt: new Date().toISOString(),
      };
      return receipt(s, roundId);
    },

    async updateComplex(req: UpdateComplex): Promise<void> {
      const s = demo.get(req.sessionId);
      if (!s) {
        if (typeof inner.updateComplex === "function") await inner.updateComplex(req);
        return;
      }
      // No audit trail to write - there is no money here - but the state
      // itself is kept, because that is what the wallet would be holding and
      // the point of this wrapper is that a demo round behaves like a real
      // one everywhere except where the money is.
      if (s.open && s.open.roundId === req.roundId) {
        s.open.state = req.state;
        s.open.version += 1;
      }
    },

    async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
      const s = demo.get(req.sessionId);
      if (!s) return inner.closeComplex(req);
      if (!s.open || s.open.roundId !== req.roundId) {
        throw new Error(`demo: no open round ${req.roundId} to close`);
      }
      s.balance += req.win;
      s.carry = req.carry;
      s.mathVersion = req.mathVersion;
      s.nextMode = req.nextMode;
      s.rounds += 1;
      s.lastRound = {
        ...s.open,
        state: req.finalState,
        ...(req.mathVersion !== undefined ? { stateVersion: req.mathVersion } : {}),
        winMultiplier: req.multiplier,
        win: req.win,
        finishedAt: new Date().toISOString(),
      };
      delete s.open;
      return receipt(s, req.roundId);
    },

    onEvent(handler: (e: PlatformEvent) => void): void {
      inner.onEvent((e) => {
        // The session ending is the end of the play money with it. Artube
        // does not persist a demo round, so there is nothing to come back to
        // and keeping the balance would make the next session start rich.
        if (e.type === "sessionClosed" && demo.delete(e.sessionId)) {
          log.info("Demo session closed, play money discarded", {
            "event.category": "artube",
            "event.action":   "demo_session_end",
            "artube.session_id": e.sessionId,
          });
        }
        // A balance event is about a real wallet. Forwarding it for a demo
        // session would overwrite the play balance with someone's real one.
        if (e.type === "balanceChanged" && isDemo(e.sessionId)) return;
        handler(e);
      });
    },
  };

  // Everything the Games API would be storing for this session, for the same
  // reason the real one is worth looking at: when a demo round behaves oddly
  // the question is what the store thinks, and there is no back office for
  // play money.
  (wrapped as PlatformAdapter & { demoSessionFor?: unknown }).demoSessionFor =
    (sessionId: string): DemoSessionView | undefined => {
      const s = demo.get(sessionId);
      if (!s) return undefined;
      return {
        balance: s.balance,
        rounds: s.rounds,
        ...(s.carry !== undefined ? { carry: s.carry } : {}),
        ...(s.mathVersion !== undefined ? { mathVersion: s.mathVersion } : {}),
        ...(s.nextMode !== undefined ? { nextMode: s.nextMode } : {}),
        ...(s.open ? { openRound: { ...s.open } } : {}),
        ...(s.lastRound ? { lastRound: { ...s.lastRound } } : {}),
      };
    };

  if (typeof inner.reverseRound === "function") {
    wrapped.reverseRound = async (req) => {
      if (isDemo(req.sessionId)) {
        // Nothing to charge back: no money moved.
        return { roundId: req.roundId, balance: demo.get(req.sessionId)!.balance, reversed: false, reason: "demo-session" };
      }
      return inner.reverseRound!(req);
    };
  }

  return wrapped as DemoCapableAdapter;
}
