// A fake Artube Games API, speaking the real wire protocol.
//
// Shared by the conformance run and the complex-round tests. It is
// deliberately strict where the real platform is strict - an unknown
// session, a stale round_version, a round that is already closed are all
// refused with the documented error codes - because an adapter that only
// ever meets a permissive fake passes here and fails on the sandbox.
//
// Money is kept in integer minor units internally and emitted in MAJOR
// units, which is what the real wire carries ("balance": 150.75). That is
// the whole point of the fixture: it is the half of the contract the
// adapter has to convert, and a fake that emitted minor units would make
// the conversion untestable.

export interface FakeArtube {
  url: string;
  stop(): void;
  /** Push an AutocloseRequestEvent for a round the fake has open. */
  requestAutoclose(roundId: string): void;
  /** Push a SessionClosedEvent for a session. */
  closeSession(sessionId: string, reason?: string): void;
  /** Every frame the adapter sent, in order. */
  readonly received: WireFrame[];
  /** Frames of one type, oldest first. */
  sent(type: string): WireFrame[];
  balanceMinor(sessionId: string): number;
  openRoundIds(): string[];
  lastRoundState(sessionId: string): string | undefined;
}

export interface WireFrame {
  type: string;
  id: string;
  schema: number;
  payload: Record<string, unknown>;
}

interface FakeRound {
  sessionId: string;
  version: number;
  betMinor: number;
  state: string;
  stateVersion: string;
  features: string[];
}

export interface FakeArtubeOptions {
  /** Bet ladder in MAJOR units. Index 2 is 1.00 so the conformance
   *  fixture's betIndex 2 / bet 100 minor units lines up. */
  ladder?: number[];
  /** Starting balance in minor units. */
  startMinor?: number;
  /** Emit `game_settings.currency_minimal_unit`. Off exercises the
   *  adapter's configured-decimals fallback. */
  sendMinimalUnit?: boolean;
  /** Suffix event type names with "Event" (both spellings are in the docs). */
  eventSuffix?: boolean;
  /** Answer Welcome with this schema. */
  welcomeSchema?: number;
  /** Session ids for which the wallet returns no currency - Artube's one and
   *  only marker for a demo session. */
  demoSessions?: string[];
}

const MINOR = 100;

export function fakeArtube(opts: FakeArtubeOptions = {}): FakeArtube {
  const ladderMajor = opts.ladder ?? [0.25, 0.5, 1, 2, 5, 10];
  const ladderMinor = ladderMajor.map((b) => Math.round(b * MINOR));
  const START = opts.startMinor ?? 1_000_000;
  const sendMinimalUnit = opts.sendMinimalUnit ?? true;
  const evt = (name: string) => (opts.eventSuffix === false ? name : `${name}Event`);
  const demoSessions = new Set(opts.demoSessions ?? []);

  const balances = new Map<string, number>();      // minor units
  const known = new Set<string>();
  const lastRounds = new Map<string, Record<string, unknown>>();
  const rounds = new Map<string, FakeRound>();
  const received: WireFrame[] = [];
  const sockets = new Set<{ send(s: string): void }>();
  let roundSeq = 0;

  const major = (minor: number) => Math.round(minor) / MINOR;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req) ? undefined : new Response("expected websocket", { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({
          proto: 1, schema: opts.welcomeSchema ?? 1, chan: "control", type: "Welcome",
          id: "w1", op_seq: 0, timestamp: new Date().toISOString(),
          payload: { use: { max_schema: opts.welcomeSchema ?? 1 } },
        }));
      },
      close(ws) { sockets.delete(ws); },
      message(ws, raw): void {
        const msg = JSON.parse(String(raw)) as WireFrame & { payload?: Record<string, unknown> };
        received.push({ type: msg.type, id: msg.id, schema: msg.schema, payload: msg.payload ?? {} });
        const p = msg.payload ?? {};

        const reply = (type: string, payload: unknown) =>
          ws.send(JSON.stringify({
            proto: 1, schema: 1, chan: "rpc", type,
            id: `r-${msg.id}`, corr_id: msg.id, op_seq: 0,
            timestamp: new Date().toISOString(), payload,
          }));
        const err = (code: string, message: string) =>
          ws.send(JSON.stringify({
            proto: 1, schema: 1, chan: "rpc", type: "Error",
            id: `e-${msg.id}`, corr_id: msg.id, op_seq: 0,
            timestamp: new Date().toISOString(), payload: { code, message },
          }));
        const pushBalance = (sid: string, reason: string) =>
          ws.send(JSON.stringify({
            proto: 1, schema: 1, chan: "events", type: evt("BalanceChanged"),
            id: crypto.randomUUID(), op_seq: 0, timestamp: new Date().toISOString(),
            payload: { session_id: sid, balance: major(balances.get(sid) ?? 0), reason },
          }));

        if (msg.type === "Hello") return;

        if (msg.type === "SessionInfoRequest") {
          const sid = String(p["session_id"] ?? "s");
          if (!balances.has(sid)) balances.set(sid, START);
          known.add(sid);
          const last = lastRounds.get(sid);
          reply("SessionInfoResponse", {
            security_hash: "hash",
            // A demo session is one with no currency. That is the whole
            // marker: same requests, same everything else.
            currency: demoSessions.has(sid) ? null : "USD",
            balance: major(balances.get(sid)!),
            ...(last ? { last_round: last } : {}),
            game_settings: {
              default_bet_index: 0,
              allowed_bets: ladderMajor,
              ...(sendMinimalUnit ? { currency_minimal_unit: 1 / MINOR } : {}),
              available_auto_spin_counts: [10, 25, 50],
              rtp_options: [{ rtp: 0.96, game_mode: "default" }],
              locales: ["en"],
            },
          });
          return;
        }

        const sid = String(p["session_id"] ?? "s");
        const betOf = () => {
          const i = Number(p["bet_index"] ?? 0);
          const price = Number(p["price_multiplier"] ?? 1);
          // An index off the end of the ladder is not a cheap bet: make it
          // unaffordable so the overspend probe fails the way it would on a
          // real wallet rather than settling at zero.
          return ladderMinor[i] === undefined
            ? Number.MAX_SAFE_INTEGER
            : Math.round(ladderMinor[i]! * price);
        };

        if (msg.type === "PlayRoundRequest") {
          if (!known.has(sid)) { err("SessionInvalid", "unknown session"); return; }
          const bet = betOf();
          const winMul = Number(p["win_multiplier"] ?? 0);
          const have = balances.get(sid) ?? START;
          if (bet > have) { err("InsufficientFunds", "not enough balance"); return; }
          const win = Math.round(bet * winMul);
          balances.set(sid, have - bet + win);
          const roundId = `round-${++roundSeq}`;
          lastRounds.set(sid, {
            round_id: roundId,
            price_multiplier: Number(p["price_multiplier"] ?? 1),
            bet_index: Number(p["bet_index"] ?? 0),
            win_multiplier: winMul,
            win: major(win),
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            round_version: 0,
            round_state_version: String(p["round_state_version"] ?? "1"),
            round_state: String(p["round_state"] ?? ""),
            is_platform_max_win_reached: false,
          });
          reply("PlayRoundResponse", {
            round_id: roundId, balance: major(balances.get(sid)!), win: major(win),
          });
          pushBalance(sid, "Win");
          return;
        }

        if (msg.type === "OpenRoundRequest") {
          if (!known.has(sid)) { err("SessionInvalid", "unknown session"); return; }
          // The platform validates the chain: a previous_round_id that is not
          // this session's actual previous round is "Invalid rounds sequence",
          // and the open fails. The fake did not model this, so an adapter
          // that chained every round looked fine here and failed on the
          // sandbox after the first simple round.
          const chain = p["previous_round_id"];
          if (chain !== undefined && chain !== null && chain !== lastRounds.get(sid)?.["round_id"]) {
            err("InvalidRoundOperation", "Invalid rounds sequence.");
            return;
          }
          const bet = betOf();
          const have = balances.get(sid) ?? START;
          if (bet > have) { err("InsufficientFunds", "not enough balance"); return; }
          balances.set(sid, have - bet);
          const roundId = `round-${++roundSeq}`;
          rounds.set(roundId, {
            sessionId: sid,
            version: 0,
            betMinor: bet,
            state: String(p["round_state"] ?? ""),
            stateVersion: String(p["round_state_version"] ?? "1"),
            features: featureTypes(p["features"]),
          });
          // An open round IS the session's last round, and it has no
          // finished_at. Modelling that is what makes the carry-from-an-open-
          // round bug reproducible here rather than only on the sandbox.
          lastRounds.set(sid, {
            round_id: roundId,
            price_multiplier: Number(p["price_multiplier"] ?? 1),
            bet_index: Number(p["bet_index"] ?? 0),
            win_multiplier: 0,
            win: 0,
            started_at: new Date().toISOString(),
            // No finished_at: that is what an open round looks like, and it
            // is the wire's own answer to "is this round still open". The
            // sandbox returns exactly this shape.
            round_version: 0,
            round_state_version: String(p["round_state_version"] ?? "1"),
            round_state: String(p["round_state"] ?? ""),
            is_platform_max_win_reached: false,
          });
          reply("OpenRoundResponse", {
            round_version: 0, round_id: roundId, balance: major(balances.get(sid)!),
          });
          pushBalance(sid, "Bet");
          return;
        }

        if (msg.type === "UpdateRoundStateRequest") {
          const roundId = String(p["round_id"] ?? "");
          const r = rounds.get(roundId);
          if (!r) { err("InvalidRoundOperation", "Round is not open."); return; }
          if (Number(p["round_version"]) !== r.version) {
            { err("InvalidRoundOperation", `Stale round_version ${String(p["round_version"])}, expected ${r.version}.`); return; }
          }
          r.version += 1;
          r.state = String(p["round_state"] ?? r.state);
          r.stateVersion = String(p["round_state_version"] ?? r.stateVersion);
          reply("UpdateRoundStateResponse", { round_version: r.version });
          return;
        }

        if (msg.type === "CloseRoundRequest" || msg.type === "AutocloseRoundRequest") {
          const roundId = String(p["round_id"] ?? "");
          const r = rounds.get(roundId);
          if (!r) { err("InvalidRoundOperation", "Round is not open."); return; }
          if (Number(p["round_version"]) !== r.version) {
            { err("InvalidRoundOperation", `Stale round_version ${String(p["round_version"])}, expected ${r.version}.`); return; }
          }
          const winMul = Number(p["win_multiplier"] ?? 0);
          const win = Math.round(r.betMinor * winMul);
          balances.set(r.sessionId, (balances.get(r.sessionId) ?? 0) + win);
          // Features merge open-on-top-of-close, as documented.
          const merged = [...new Set([...r.features, ...featureTypes(p["features"])])];
          rounds.delete(roundId);
          lastRounds.set(r.sessionId, {
            round_id: roundId,
            price_multiplier: 1,
            bet_index: 0,
            win_multiplier: winMul,
            win: major(win),
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            round_version: Number(p["round_version"] ?? 0),
            round_state_version: String(p["round_state_version"] ?? "1"),
            round_state: String(p["round_state"] ?? ""),
            features: merged.map((t) => ({ type: t })),
            is_platform_max_win_reached: false,
          });
          reply("CloseRoundResponse", {
            balance: major(balances.get(r.sessionId)!),
            win: major(win),
            is_platform_max_win_reached: false,
          });
          pushBalance(r.sessionId, "Win");
          return;
        }

        err("BadRequest", `unknown type ${msg.type}`);
      },
    },
  });

  return {
    url: `ws://localhost:${server.port}`,
    stop: () => server.stop(true),
    received,
    sent: (type: string) => received.filter((f) => f.type === type),
    balanceMinor: (sessionId: string) => balances.get(sessionId) ?? 0,
    openRoundIds: () => [...rounds.keys()],
    lastRoundState: (sessionId: string) =>
      lastRounds.get(sessionId)?.["round_state"] as string | undefined,
    closeSession(sessionId: string, reason = "player left") {
      const frame = JSON.stringify({
        proto: 1, schema: 1, chan: "events", type: evt("SessionClosed"),
        id: crypto.randomUUID(), op_seq: 0, timestamp: new Date().toISOString(),
        payload: { session_id: sessionId, reason },
      });
      for (const ws of sockets) ws.send(frame);
    },
    requestAutoclose(roundId: string) {
      const r = rounds.get(roundId);
      if (!r) throw new Error(`fake: no open round ${roundId}`);
      const frame = JSON.stringify({
        proto: 1, schema: 1, chan: "events", type: evt("AutocloseRequest"),
        id: crypto.randomUUID(), op_seq: 0, timestamp: new Date().toISOString(),
        payload: {
          session_id: r.sessionId,
          round_id: roundId,
          round_version: r.version,
          round_state_version: r.stateVersion,
          round_state: r.state,
        },
      });
      for (const ws of sockets) ws.send(frame);
    },
  };
}

function featureTypes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((f) => (f && typeof f === "object" ? String((f as { type?: unknown }).type ?? "") : ""))
    .filter((t) => t !== "");
}
