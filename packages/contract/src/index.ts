// @open-rgs/contract
//
// The public contract every part of an Open-RGS system targets:
// - Math authors implement MathModule (Simple, Complex, or both).
// - Operator integrators implement PlatformAdapter  - the single surface
//   the RGS uses to talk to the upstream operator's back-office. It
//   covers four responsibilities: session lifecycle + authoritative
//   state, money movement (the "wallet" part), promo free-rounds
//   (granted-from-platform bonuses), and an event source. How the
//   adapter assembles those internally (one WS, three microservices,
//   a polling loop with a cache  - anything) is the integrator's call.
// - Transport authors implement ClientTransport.
// - Game integrators compose maths into a GameManifest via defineGame().
//
// Zero runtime, zero deps.

// --- Round outputs ----------------------------------------------------------

/** Opaque, math-owned blob that threads from one round to the next on the
 *  same session. Core never inspects it. */
export type CarryState = string;

/** Opaque, math-owned blob that threads through a complex round's
 *  open / step / close calls. Core never inspects it. */
export type RoundState = string;

/** Opaque-to-core visual ops. Math authors define the shape; the client
 *  replays them. Core only forwards. */
export type Op = unknown;

/** Player-supplied action during a complex round (e.g. {type:"hit"}). */
export type PlayerAction = { type: string; [k: string]: unknown };

/** Hint to the client about what action is expected next. */
export interface AwaitingHint {
  /** Action type the math expects. The wrapper will reject mismatched actions. */
  type: string;
  /** Optional list of valid values for the action's primary parameter. */
  options?: unknown[];
  /** Optional UX hint: ms-budget for this step. NOT enforced by the engine
   *  (autoclose is external-trigger only  - there are no in-process step
   *  timers); a client may use it to show a countdown. */
  deadline?: number;
  /** Optional UX hint for the client. */
  prompt?: string;
}

/** What a simple-round math returns from play(). */
export interface RoundOutcome {
  multiplier: number;          // dimensionless win multiplier (0 = loss)
  ops: Op[];                   // visual instructions for the client
  type: string;                // game-defined tag, e.g. "win" / "loss" / "trigger-fs"
  carry?: CarryState;          // state for the *next* round on this session
  nextMode?: string;           // route the next round into a specific mode
}

/** What a complex-round math returns from open(). */
export interface OpenOutcome {
  state: RoundState;
  ops: Op[];
  awaiting?: AwaitingHint;     // null = round is already terminal
}

/** What a complex-round math returns from step(). */
export interface StepOutcome {
  state: RoundState;
  ops: Op[];
  awaiting?: AwaitingHint;     // null = ready to close
}

/** What a complex-round math returns from close(). */
export interface CloseOutcome {
  multiplier: number;
  ops: Op[];
  type: string;
  carry?: CarryState;
  nextMode?: string;
}

// --- Round inputs -----------------------------------------------------------

/** Per-spin context the wrapper hands math. Currency-blind. */
export interface SpinContext {
  /** Mode id resolved by the wrapper (after promo override / nextMode override). */
  mode: string;
  /** Dev-only forced-outcome hint. Populated by the orchestrator ONLY when
   *  cheats are explicitly enabled (createServer `enableCheats` /
   *  `OPEN_RGS_ENABLE_CHEATS=1`) AND not in production  - it is always
   *  `undefined` in production, regardless of how `NODE_ENV` is set. It is
   *  NOT a field of the wire request (a forced-outcome field must never be
   *  part of the canonical contract); in dev it is carried inside
   *  `ClientRequestSpin.params.cheat`. */
  cheat?: CheatHint;
  /** Free-form game-specific parameters. */
  params?: Record<string, unknown>;
}

/** Dev-only forced outcome hints. See SpinContext.cheat  - never reaches a
 *  production build. */
export interface CheatHint {
  force_win?: boolean;
  force_coeff?: number;
  force_feature?: string;
  force_big_win?: boolean;
  force_noop?: boolean;
}

// --- Math expectations + marks ----------------------------------------------
//
// Author-declared intent + runtime annotations the simulator uses to
// produce a "targets vs measured" diagnosis. None of this is wired in
// the orchestrator  - marks are a math-author + simulator concern.

/** A target value the simulator compares its measurement against.
 *  `tolerance` is absolute; if absent, defaults to 5% of |target|. */
export interface MathTarget {
  target: number;
  /** Absolute tolerance band around target. Defaults to |target| * 0.05. */
  tolerance?: number;
}

/** What the math author claims the math should do. The simulator
 *  computes deviation from each declared target and flags ok / warn / fail. */
export interface MathExpectations {
  /** Expected fraction of spins with multiplier > 0. */
  hitRate?: MathTarget;
  /** Expected fire-rate per spin for named counters: rate[name] = count(name)/spins. */
  rate?: Record<string, MathTarget>;
  /** Expected RTP contribution per named bucket; contribution[name] = sum(contribute(name, m)) * bet / total_bet. */
  rtpContribution?: Record<string, MathTarget>;
  /** Expected fraction of spins tagged with each name. */
  tagShare?: Record<string, MathTarget>;
}

/** The collector backing `host.mark.*` calls in Lua. The simulator
 *  drives the per-spin lifecycle (beginSpin / endSpin) and reads the
 *  final snapshot. The orchestrator never touches it  - marks are
 *  inert outside a simulator run. */
export interface MarkCollector {
  /** Increment named counter. Called from math.play() via host.mark.count. */
  count(name: string): void;
  /** Append value to named histogram. */
  observe(name: string, value: number): void;
  /** Tag this spin under name. Each spin contributes at most 1 to the tag's count, even if called many times. */
  tag(name: string): void;
  /** Add multiplier to a named RTP-attribution bucket. */
  contribute(name: string, multiplier: number): void;
  /** Lifecycle: simulator calls before each math.play(). */
  beginSpin(): void;
  /** Lifecycle: simulator calls after each math.play(). */
  endSpin(): void;
  /** Snapshot raw aggregates. The simulator post-processes this. */
  snapshot(): MarkSnapshot;
}

export interface MarkSnapshot {
  counts: Record<string, number>;
  /** Per-name list of observed values. Caller computes stats. */
  observations: Record<string, number[]>;
  /** Per-name count of spins tagged. */
  tagSpins: Record<string, number>;
  /** Per-name sum of multiplier contributions. */
  contributions: Record<string, number>;
  /** Total spins completed (incremented on endSpin). */
  spinsCompleted: number;
}

// --- Math contract ----------------------------------------------------------

/** Pure simple-round math: prev -> outcome. Currency-blind, RNG-injected.
 *
 *  Math returns a multiplier and ops. Core multiplies multiplier x bet to
 *  get the win amount and sends both ops and balance to the client as
 *  separate response fields. Math NEVER sees balance, bet, or currency. */
export interface SimpleMath {
  readonly kind: "simple";
  readonly name: string;
  readonly version: string;
  /** Theoretical RTP of *this math*, verified by simulator. */
  readonly rtp: number;
  /** Optional author-declared expectations (target hit rate, fire rates,
   *  RTP contributions). Picked up by the simulator for deviation reports. */
  readonly expected?: MathExpectations;
  /** Optional mark collector. Populated by the loader when marks are
   *  opted in (loadLuaMath({ marks: true })). Simulator uses it; the
   *  orchestrator ignores it. */
  readonly marks?: MarkCollector;
  /** SHA-256 of the math source (hex). Populated by loadLuaMath at
   *  load time. Stamped on every round so the platform / audit log
   *  can prove which version of the math computed a given outcome. */
  readonly contentHash?: string;

  play(prev: CarryState | undefined, ctx: SpinContext): RoundOutcome | Promise<RoundOutcome>;
}

/** Complex-round math: open -> step* -> close. Carry threads across rounds.
 *  Same currency-blindness as SimpleMath. */
export interface ComplexMath {
  readonly kind: "complex";
  readonly name: string;
  readonly version: string;
  readonly rtp: number;
  readonly expected?: MathExpectations;
  readonly marks?: MarkCollector;
  /** SHA-256 of the math source (hex). See SimpleMath.contentHash. */
  readonly contentHash?: string;

  open(prev: CarryState | undefined, ctx: SpinContext): OpenOutcome | Promise<OpenOutcome>;
  step(state: RoundState, action: PlayerAction): StepOutcome | Promise<StepOutcome>;
  isTerminal(state: RoundState): boolean | Promise<boolean>;
  close(state: RoundState): CloseOutcome | Promise<CloseOutcome>;

  /** Optional autoclose resolver: produce a close outcome from current state. */
  autoclose?(state: RoundState): CloseOutcome | Promise<CloseOutcome>;
}

export type MathModule = SimpleMath | ComplexMath;

// --- Game manifest ----------------------------------------------------------

export interface GameMode {
  /** Math implementation backing this mode. */
  math: MathModule;
  /** Bet stake-multiplier (base = 1, feature buys typically 10-100). */
  stakeMultiplier: number;
  /** Human-readable label surfaced to the client. */
  label?: string;
  /** True = mode cannot be requested by the client directly; only routed
   *  into via another math's nextMode. (e.g. "free-spins" mode triggered
   *  by base game.) */
  internal?: boolean;
  /** Per-mode RTP for the mode catalog and certification. Defaults to math.rtp. */
  declaredRtp?: number;
  /** Per-mode max-win cap as a multiple of `bet` (post-stakeMultiplier).
   *  e.g. maxWinMultiplier=10000 means the orchestrator will cap any
   *  single round's win at 10,000 x bet. Most jurisdictions require this.
   *  When the cap fires, win is clipped, multiplier recomputed, and
   *  the outcome type becomes "max_win_reached" (preserves authorship). */
  maxWinMultiplier?: number;
}

export type AutoclosePolicy =
  | { policy: "settle-at-current" }
  | { policy: "settle-as-loss" }
  | { policy: "hold" }
  | { policy: "math-decides" };

/** NOTE: declared but NOT yet enforced. Cross-process restart recovery needs
 *  a wallet open-round inquiry endpoint that isn't specified yet; today the
 *  orchestrator always discards in-memory state on restart. Tracked in
 *  Spec 09 (roadmap). */
export interface RecoveryPolicy {
  /** What to do with rounds left open across server restart. */
  onRestart: "resume" | "forfeit" | "autoclose";
}

export interface GameManifest {
  id: string;
  declaredRtp: number;
  modes: Record<string, GameMode>;
  /** Default mode id used when client doesn't supply one. */
  defaultMode: string;
  autoclose?: { idleMs: number } & AutoclosePolicy;
  recovery?: RecoveryPolicy;
  /** Game-wide max-win cap as a multiple of `bet`. Overridden per-mode
   *  via GameMode.maxWinMultiplier. Most regulators require this. */
  maxWinMultiplier?: number;
}

/** Identity helper: validates and freezes the manifest. */
export function defineGame(m: GameManifest): GameManifest {
  if (!m.id) throw new Error("GameManifest.id required");
  if (!m.modes || Object.keys(m.modes).length === 0) {
    throw new Error("GameManifest.modes must be non-empty");
  }
  const defaultMode = m.modes[m.defaultMode];
  if (!defaultMode) {
    throw new Error(`defaultMode '${m.defaultMode}' not in modes`);
  }
  // The default mode must be client-reachable  - routing to an internal-only
  // mode by default strands every fresh round.
  if (defaultMode.internal) {
    throw new Error(`defaultMode '${m.defaultMode}' is internal  - pick a client-reachable default`);
  }
  // RTP is a fraction (0.96 = 96%); the overall game figure must be <= 1.
  if (!Number.isFinite(m.declaredRtp) || m.declaredRtp < 0 || m.declaredRtp > 1) {
    throw new Error(`GameManifest.declaredRtp must be a finite number in [0, 1], got ${m.declaredRtp}`);
  }
  if (m.maxWinMultiplier !== undefined && (!Number.isFinite(m.maxWinMultiplier) || m.maxWinMultiplier <= 0)) {
    throw new Error(`GameManifest.maxWinMultiplier must be a positive finite number, got ${m.maxWinMultiplier}`);
  }
  for (const [id, mode] of Object.entries(m.modes)) {
    if (typeof mode.stakeMultiplier !== "number" || !Number.isFinite(mode.stakeMultiplier) || mode.stakeMultiplier < 0) {
      throw new Error(`mode '${id}' has invalid stakeMultiplier`);
    }
    if (!mode.math || (mode.math.kind !== "simple" && mode.math.kind !== "complex")) {
      throw new Error(`mode '${id}' has no math or an invalid math.kind`);
    }
    // Per-mode declaredRtp may exceed 1 (a bonus mode measured in isolation
    // is funded by the base), so only require it finite and non-negative.
    if (mode.declaredRtp !== undefined && (!Number.isFinite(mode.declaredRtp) || mode.declaredRtp < 0)) {
      throw new Error(`mode '${id}' has invalid declaredRtp`);
    }
    if (mode.maxWinMultiplier !== undefined && (!Number.isFinite(mode.maxWinMultiplier) || mode.maxWinMultiplier <= 0)) {
      throw new Error(`mode '${id}' has invalid maxWinMultiplier`);
    }
  }
  // Deep-freeze each mode too  - the old shallow freeze left nested mode/math
  // objects mutable.
  const frozenModes: Record<string, GameMode> = {};
  for (const [id, mode] of Object.entries(m.modes)) frozenModes[id] = Object.freeze({ ...mode });
  return Object.freeze({ ...m, modes: Object.freeze(frozenModes) }) as GameManifest;
}

// --- Platform adapter contract ----------------------------------------------
//
// One interface for everything upstream of the RGS. The implementation can
// fan out to as many backend services as it likes; from the RGS's side this
// is a single connected adapter with a healthy/unhealthy status, a fixed
// RPC surface, and an event stream.

export interface SessionInfo {
  sessionId: string;
  /** Empty string = demo session (no real wallet). */
  currency: string;
  /** Fractional digits of `currency`. EUR/USD/RUB = 2, JPY/HUF = 0,
   *  BTC = 8. The adapter sources this from the upstream platform
   *  (config, DB, openSession response  - whatever the provider
   *  exposes) and returns it here.
   *
   *  RGS itself NEVER converts amounts. Every `balance`, `bet`, and
   *  `win` in this contract is an integer in the currency's minimal
   *  unit (USD 1.00 -> balance = 100 when currencyDecimals = 2).
   *  This field exists so adapters facing decimal- or float-wire
   *  platforms can convert at their outbound boundary with an
   *  explicit number of fractional digits  - see
   *  `@open-rgs/adapter-kit/currency` for helpers. */
  currencyDecimals: number;
  /** Balance in the currency's minimal unit (integer). USD 1.00 = 100. */
  balance: number;
  /** Bet ladder, in the currency's minimal unit. */
  allowedBets: number[];
  defaultBetIndex: number;
  /** Active promo free-rounds pool, if any. */
  promo?: PromoFreeRounds;
  /** Open round to resume on reconnect, if any. */
  openRound?: OpenRoundResume;
  /** Last math carry from this player's most recent COMPLETED round.
   *  Adapter is the source of truth for cross-round state  - it stores the
   *  carry alongside its own round-settle records and returns it here on
   *  next session-open. RGS uses this to seed the next round's math.play()
   *  or math.open(). */
  carry?: CarryState;
  /** Math's "next mode" hint from the most recent completed round.
   *  Same persistence pattern as carry: adapter stores it, returns it
   *  here. RGS uses it to override the requested mode on the next round. */
  nextMode?: string;
  /** Math version that produced the stored carry/nextMode. If it doesn't
   *  match the currently-loaded math, RGS discards the carry and starts
   *  fresh (manifest.recovery policy). */
  mathVersion?: string;
}

/** Promo free-rounds: a pool of platform-granted bonus rounds the player
 *  can opt into. RGS-side support is intentionally minimal  - when the
 *  pool is active, RGS forces `bet` from the pool (instead of from
 *  `allowedBets[betIndex]`) and does not debit real balance. Each
 *  consumed round decrements `remaining` locally; at zero the pool
 *  disappears.
 *
 *  Bonus engines (campaigns, jackpots, tournaments, cashback, leaderboards
 *  etc.) live OUTSIDE open-rgs  - see specs/05-platform-protocol.md. The
 *  adapter maps whatever shape its upstream uses (campaignId, freebetId,
 *  bonusId) into this opaque `id`. RGS treats `id` as a black box. */
export interface PromoFreeRounds {
  /** Opaque id  - adapter-defined (campaignId, freebetId, promoId, ...).
   *  RGS passes it back unchanged on every settle so the adapter can
   *  attribute consumption to the right upstream record. */
  id: string;
  /** Bet per round, in the currency's minimal unit (integer). */
  bet: number;
  /** Rounds remaining in the pool. RGS decrements locally; at 0 the
   *  pool is removed. */
  remaining: number;
  /** Optional  - the pool is only consumable in these modes. */
  modeFilter?: string[];
  /** Optional UX hint surfaced to the client. */
  label?: string;
  /** Optional UX hint  - total rounds initially granted, for progress
   *  display ("3 of 10"). Sticky for the lifetime of the pool. */
  total?: number;
  /** Optional UX hint  - ISO 8601 expiry. RGS does not enforce it
   *  (autoclose is external); for client display only. */
  validTo?: string;
}

/** Resume payload sent to the client at INIT when a round is in flight.
 *  Tells the client "what happened" (cumulative ops + action history)
 *  and "what's next" (the awaiting hint). The client replays opsLog to
 *  rebuild visual state, then renders a UI for awaiting. */
export interface OpenRoundResume {
  roundId: string;
  modeId: string;
  bet: number;
  /** Cumulative ops emitted so far (open + every step). Replay to render. */
  ops: Op[];
  /** Player actions taken so far in this round. */
  actionLog: PlayerAction[];
  /** Currently expected action; null/absent = round is closing. */
  awaiting?: AwaitingHint;
  /** Wall-clock time (ms epoch) the round opened  - UX hint. */
  openedAt?: number;
}

export interface SettleSimple {
  sessionId: string;
  /** Final bet in currency's minimal unit (integer).
   *  Includes priceMultiplier x stakeMultiplier already. */
  bet: number;
  /** Index into the session's allowed_bets ladder  - what the player picked. */
  betIndex: number;
  /** Multiplier applied to the chosen bet level (mode stakeMultiplier x priceMultiplier). */
  priceMultiplier: number;
  /** Win in the currency's minimal unit (integer). */
  win: number;
  /** Dimensionless win multiplier from math. */
  multiplier: number;
  type: string;
  /** This round's final math state. Doubles as carry for next round
   *  (simple rounds open + close atomically, so per-round = cross-round). */
  roundState: string;
  /** Math's nextMode hint for routing the next round. */
  nextMode?: string;
  /** Math version that produced this state. */
  mathVersion?: string;
  /** Promo pool id this round was consumed from, if any (see
   *  PromoFreeRounds). The adapter uses this to attribute the round
   *  to the right upstream campaign / freebet / bonus record. */
  promoId?: string;
  /** Idempotency key  - RGS-generated. Adapter forwards if upstream supports it. */
  idempotencyKey?: string;
}

export interface OpenComplex {
  sessionId: string;
  bet: number;
  betIndex: number;
  priceMultiplier: number;
  initialState: RoundState;
  mathVersion?: string;
  /** Promo pool id this round was consumed from, if any. */
  promoId?: string;
  idempotencyKey?: string;
}

export interface UpdateComplex {
  sessionId: string;
  roundId: string;
  state: RoundState;
}

export interface CloseComplex {
  sessionId: string;
  roundId: string;
  /** Math's final state for this round  - opaque, persisted as the wallet's
   *  audit-grade round_state. */
  finalState: RoundState;
  /** Cross-round carry math wants threaded into the NEXT round.
   *  Different from finalState (which is THIS round's state).
   *  Adapter persists for return on next openSession.carry. */
  carry?: CarryState;
  /** Math's "next mode" hint for the next round on this session. */
  nextMode?: string;
  /** Math version that produced this state. Adapter stores alongside carry. */
  mathVersion?: string;
  win: number;
  multiplier: number;
  type: string;
  /** Idempotency key  - RGS-generated. Adapter forwards to the wallet
   *  if the wallet supports dedupe. */
  idempotencyKey?: string;
  /** Set when this close was an AUTOCLOSE (external trigger), carrying the
   *  trigger reason for the wallet's audit trail (e.g. "session-closed",
   *  "idle-timeout"). Absent for a normal client-initiated close. */
  reason?: string;
}

export interface RoundReceipt {
  roundId: string;
  balance: number;
  /** Updated promo pool state after the adapter consumed a round from
   *  it. RGS uses `remaining` to update its local view. Anything else
   *  about the bonus (cumulative win, completion flags, leaderboard
   *  contribution, ...) is platform-side and never crosses this surface. */
  promo?: { remaining: number };
}

export type PlatformEvent =
  | { type: "balanceChanged"; sessionId: string; balance: number; reason: string }
  | { type: "sessionClosed"; sessionId: string; reason: string }
  | { type: "promoGranted"; sessionId: string; promo: PromoFreeRounds }
  /** Wallet asks the RGS to autoclose an in-flight round. RGS-side autoclose
   *  is NEVER timer-driven  - every autoclose is initiated by an external
   *  signal (this event from the wallet, an admin HTTP call, or an
   *  upstream operator script). */
  | { type: "autocloseRequested"; sessionId: string; roundId?: string; reason: string };

export interface PlatformAdapter {
  connect(): Promise<void>;
  disconnect(): void;

  readonly isHealthy: boolean;
  readonly diagnostics: Record<string, unknown>;

  openSession(sessionId: string, connectionId: string): Promise<SessionInfo>;

  /** Settle a simple-round transaction (bet + win in one call). */
  settleSimple(req: SettleSimple): Promise<RoundReceipt>;

  /** Open a complex round (debit only). */
  openComplex(req: OpenComplex): Promise<RoundReceipt>;
  /** Audit-only state update (no money moves). Optional. */
  updateComplex?(req: UpdateComplex): Promise<void>;
  /** Close a complex round (credit win). */
  closeComplex(req: CloseComplex): Promise<RoundReceipt>;

  onEvent(handler: (e: PlatformEvent) => void): void;
}

// --- Lua extension contract -------------------------------------------------
//
// By default a math file gets two host helpers (host.rng_next and
// host.log_debug) and nothing else. Real ecosystems need more  - reel
// utilities, paytable evaluators, distribution helpers, sometimes even
// DSL preprocessors. Extensions are how that lands in the Lua VM without
// core needing to know what a "reel" is.
//
// An extension is one of three things, often combined:
//   - a pure-Lua module returned by require("<name>")
//   - a table of native (TS) functions merged into that same module
//   - a source transform applied before any Lua code is evaluated
//
// Extensions are registered per-math via loadLuaMath(path, { extensions: [...] }).
// They install once into a fresh VM, then math sees them via require().

/** Minimal handle the loader gives extensions for VM-level operations.
 *  Kept tiny on purpose; if you need more than setGlobal you probably
 *  want a peer package, not an extension. */
export interface LuaVm {
  /** Register a value as a global on the Lua side. Use sparingly; the
   *  per-extension namespace via {@link LuaExtension.host} is preferred. */
  setGlobal(name: string, value: unknown): void;
}

export interface LuaExtension {
  /** Module name. `require("<name>")` in Lua returns the installed table. */
  name: string;
  /** Semver. Surfaced in logs + admin diagnostics for debuggability. */
  version: string;
  /** Pure-Lua source. Evaluated once during install; the returned table
   *  becomes the require() result. Optional  - a host-only extension is
   *  legal. */
  lua?: string;
  /** Native helpers exposed to Lua. Merged into the table require()
   *  returns, shadowing same-named keys from `lua`. Use for hot paths
   *  (SIMD, native crypto, fast RNG variants) or for things Lua can't
   *  reasonably do (filesystem, network  - though both should be rare in
   *  math). */
  host?: (vm: LuaVm) => Record<string, unknown>;
  /** Pre-evaluation source transform. Runs once per source string
   *  (every extension's `lua`, plus every loaded math file), in the
   *  order extensions are registered. Use for DSL expansion (a reel-
   *  strip shorthand, for instance), Teal->Lua compilation, or
   *  build-flavour conditionals. Identity is a no-op; pass-through is
   *  the default by omission. */
  transform?: (source: string, path: string) => string;
}

// --- Client transport contract ----------------------------------------------

/** Wire correlation-id key. The client stamps a unique id on each request
 *  payload under this key; the transport echoes it on the matching response /
 *  error frame. The client matches responses by this id (not just frame
 *  type), so a late/duplicate response from a timed-out call can't resolve a
 *  newer request. Reserved  - math/clients must not use it for game data. */
export const WIRE_CORRELATION_KEY = "$cid";

export interface ClientRequestInit { sid: string }
export interface ClientRequestSpin {
  sid?: string;
  mode?: string;
  betIndex?: number;
  priceMultiplier?: number;
  params?: Record<string, unknown>;
  /** Optional client-generated idempotency token. A round-initiating call
   *  (spin/open) has no server-side round id yet, so the ONLY way to make a
   *  blind retry of it deduplicable is for the client to resend the same
   *  token. Supply a stable token (e.g. a UUID minted once per logical
   *  spin) and reuse it across every retry of that spin. */
  idempotencyKey?: string;
}
export interface ClientRequestOpenRound  { sid?: string; mode?: string; betIndex?: number; priceMultiplier?: number; params?: Record<string, unknown>; idempotencyKey?: string }
export interface ClientRequestStepRound  { sid?: string; action: PlayerAction }
export interface ClientRequestCloseRound { sid?: string }
export interface ClientRequestPromoAccept { sid?: string; accept: boolean }

export interface ClientResponseInit {
  sid: string;
  balance: number;
  currency: string;
  /** Fractional digits of `currency`. Same value as `SessionInfo.currencyDecimals`,
   *  surfaced to the client so it can render balances/bets correctly without
   *  hard-coding a 2-decimal assumption. */
  currencyDecimals: number;
  allowedBets: number[];
  defaultBetIndex: number;
  modes: { id: string; label?: string; stakeMultiplier: number; declaredRtp?: number }[];
  /** Active promo free-rounds pool surfaced to the client for the
   *  opt-in offer. Mirrors `SessionInfo.promo`. Absent when none. */
  promo?: { id: string; bet: number; remaining: number; total?: number; label?: string; validTo?: string };
  /** A round was in flight when the player disconnected  - replay it.
   *  ops:        full cumulative ops sequence (open + every step) so the
   *              client can rebuild the visual state.
   *  actionLog:  the player's prior actions in this round.
   *  awaiting:   what action is currently expected (null = round closing).
   *  bet:        the locked bet for this round.
   *  modeId:     which mode the round is being played in.
   *  openedAt:   epoch ms when the round opened (UX hint). */
  resume?: OpenRoundResume;
  demo?: boolean;
}

export interface ClientResponseSpin {
  roundId: string;
  ops: Op[];
  balance: number;
  bet: number;
  win: number;
  multiplier: number;
  type: string;
  /** Updated promo pool view after this round, if a promo was consumed.
   *  `done: true` when the pool has been drained (remaining === 0). */
  promo?: { remaining: number; done: boolean };
}

export interface ClientResponseOpenRound {
  roundId: string;
  ops: Op[];
  balance: number;
  bet: number;
  awaiting?: AwaitingHint;
}

export interface ClientResponseStepRound {
  ops: Op[];
  awaiting?: AwaitingHint;
}

export interface ClientResponseCloseRound {
  roundId: string;
  ops: Op[];
  balance: number;
  win: number;
  multiplier: number;
  type: string;
}

export interface ClientResponsePromoAccept {
  ok: boolean;
  promo?: { id: string; bet: number; remaining: number; total?: number };
}

export interface ClientResponseError { code: RGSErrorCode; message: string }

/** External (non-client) trigger to autoclose an in-flight round. */
export interface AutocloseRequest {
  sessionId: string;
  /** Optional: if provided, must match the in-flight round's id. */
  roundId?: string;
  reason: string;
}

export interface AutocloseResponse {
  closed: boolean;
  roundId?: string;
  /** If false, includes a human-readable reason. */
  reason?: string;
}

/** What the orchestrator hands a transport to drive client interactions. */
export interface OrchestratorAPI {
  init(req: ClientRequestInit, conn: ConnectionMeta): Promise<ClientResponseInit>;
  spin(req: ClientRequestSpin, conn: ConnectionMeta): Promise<ClientResponseSpin>;
  openRound(req: ClientRequestOpenRound, conn: ConnectionMeta): Promise<ClientResponseOpenRound>;
  stepRound(req: ClientRequestStepRound, conn: ConnectionMeta): Promise<ClientResponseStepRound>;
  closeRound(req: ClientRequestCloseRound, conn: ConnectionMeta): Promise<ClientResponseCloseRound>;
  promoAccept(req: ClientRequestPromoAccept, conn: ConnectionMeta): Promise<ClientResponsePromoAccept>;
  /** External autoclose trigger  - called by wallet event handler, admin
   *  HTTP endpoint, or any other out-of-band signal. NEVER timer-driven. */
  autocloseRound(req: AutocloseRequest): Promise<AutocloseResponse>;
  /** Called by transport when a connection drops. */
  onDisconnect(conn: ConnectionMeta): void;
}

export interface ConnectionMeta {
  /** Per-connection id; survives until WS close. */
  connectionId: string;
  /** Session id once INIT has run; null before. */
  sessionId: string | null;
  /** Demo mode flag, set by INIT. */
  demo: boolean;
}

export interface ClientTransport {
  start(api: OrchestratorAPI): Promise<{ port: number }>;
  /** Stop accepting new connections. With opts.drainMs > 0, also waits
   *  for in-flight requests to complete (or that ms to elapse). */
  stop(opts?: { drainMs?: number }): void | Promise<void>;
}

// --- Idempotency strategy --------------------------------------------------

/** How RGS stamps state-changing wallet RPCs for retry-safety.
 *  Configured at boot via `createServer({ idempotency: ... })`.
 *
 *  Keys for *settling a known round* (close / autoclose) are derived
 *  deterministically from `(sessionId, roundId)`, so every close path and
 *  every retry of a round collapse to one wallet credit  - `generate` is not
 *  used for those. `generate` is the fallback for a round-INITIATING call
 *  (simple spin / complex open) when the client supplies no idempotency
 *  token; default uuid-v4.
 *
 *  The deterministic derivation helper is exported from @open-rgs/core:
 *    import { deriveIdempotencyKey } from "@open-rgs/core";
 *
 *  Wallets MUST dedupe on `idempotencyKey` for the retry-safety guarantee
 *  to hold  - see specs/05-platform-protocol.md.
 */
export interface IdempotencyConfig {
  /** Random fallback generator for round-initiating calls with no client
   *  token. Defaults to uuid-v4. */
  generate?: () => string;
  /** TTL for retry dedupe window, in ms. Defaults to 300_000 (5 min). */
  ttlMs?: number;
}

// --- Concurrency policy ----------------------------------------------------

/** What to do when a second WS connection arrives for an existing session.
 *  NOTE: declared but NOT yet enforced  - second connections to a live
 *  session are currently unmanaged at the transport level (per-session
 *  *operation* serialization exists in the orchestrator; connection-level
 *  policy does not). Tracked in Spec 09 (roadmap). */
export type ConcurrencyPolicy = "kick-old" | "reject-new";

// --- Numeric convention ----------------------------------------------------

/** All currency amounts in this contract are integers in the currency's
 *  minimal unit. Examples:
 *    USD 1.00       -> 100
 *    EUR 0.05       -> 5
 *    BTC 0.00000001 -> 1
 *    JPY 100        -> 100
 *  Adapters that persist to floats may convert at the boundary; the
 *  contract guarantees integer ingress and integer egress. */


// --- Canonical error vocabulary ---------------------------------------------

export type RGSErrorCode =
  | "INVALID_FORMAT"
  | "DECODE_ERROR"
  | "MISSING_SESSION"
  | "SESSION_NOT_FOUND"
  | "SESSION_INVALID"
  | "INSUFFICIENT_BALANCE"
  | "INVALID_BET"
  | "INVALID_MODE"
  | "INVALID_ACTION"
  | "INVALID_ROUND"
  | "PLATFORM_UNAVAILABLE"
  /** Math exceeded its per-call execution budget and was aborted (see
   *  loadLuaMath `timeoutMs`). Protects the single-threaded server from a
   *  runaway/hostile math file. */
  | "MATH_TIMEOUT"
  | "ROUND_ALREADY_OPEN"
  | "NO_ROUND_OPEN"
  | "INTERNAL_ERROR"
  | "INIT_FAILED"
  | "SPIN_FAILED"
  | "OPEN_FAILED"
  | "STEP_FAILED"
  | "CLOSE_FAILED";

export class RGSError extends Error {
  constructor(public readonly code: RGSErrorCode, message: string) {
    super(message);
    this.name = "RGSError";
  }
}
