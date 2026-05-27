# Spec 01 — Public Contracts

## Goal

Define the four interfaces every integrator targets, with semantic
guarantees and breaking-change policy. These types live in
`@open-rgs/contract` and are the single source of truth for the
public API.

## The four contracts

```
       ┌───────────────────────────────────────────┐
       │              GameManifest                  │  composition layer
       │  modes: { default, buy-fs, free-spins }    │
       └─────────┬─────────────────────────┬───────┘
                 │                          │
                 ▼                          ▼
         ┌──────────────┐          ┌──────────────────┐
         │  MathModule  │          │  PlatformAdapter  │
         └──────────────┘          └──────────────────┘
                                          │
                                  ┌──────────────────┐
                                  │  ClientTransport │
                                  └──────────────────┘
```

## 1. MathModule

Two flavours, distinguished by `kind`:

```ts
interface SimpleMath {
  readonly kind: "simple";
  readonly name: string;
  readonly version: string;
  readonly rtp: number;

  play(prev: CarryState | undefined, ctx: SpinContext): RoundOutcome | Promise<RoundOutcome>;
}

interface ComplexMath {
  readonly kind: "complex";
  readonly name: string;
  readonly version: string;
  readonly rtp: number;

  open(prev: CarryState | undefined, ctx: SpinContext): OpenOutcome | Promise<OpenOutcome>;
  step(state: RoundState, action: PlayerAction): StepOutcome | Promise<StepOutcome>;
  isTerminal(state: RoundState): boolean | Promise<boolean>;
  close(state: RoundState): CloseOutcome | Promise<CloseOutcome>;
  autoclose?(state: RoundState): CloseOutcome | Promise<CloseOutcome>;
}

type MathModule = SimpleMath | ComplexMath;
```

### Semantic guarantees the contract makes

- **Currency-blindness**: math NEVER receives bet, balance, currency, or
  win amount. It receives an opaque `prev` carry blob and a `SpinContext`
  (mode + optional cheat). It returns a *dimensionless* multiplier.
- **RNG injection**: math does not own its RNG. The host provides
  `host.rng_next()` (Lua) or an equivalent import (WASM). Same source
  file produces same outputs given same inputs.
- **No I/O**: math has no filesystem, network, clock, or environment
  access. Pure-ish: `(prev, ctx, rng_seq) → outcome`.
- **No persistence**: state lives in the carry blob (returned to core,
  threaded back next round) or in the `RoundState` blob (between
  open/step/close). Core never inspects either.
- **`autoclose` is an external trigger**: the optional `autoclose(state)`
  function runs ONLY when an external signal asks for it (wallet event
  or admin API call). Math never schedules itself.

### What math returns

```ts
interface RoundOutcome {        // simple
  multiplier: number;
  ops: Op[];
  type: string;
  carry?: CarryState;
  nextMode?: string;
}

interface OpenOutcome {         // complex / open
  state: RoundState;
  ops: Op[];
  awaiting?: AwaitingHint;
}

interface StepOutcome {         // complex / step
  state: RoundState;
  ops: Op[];
  awaiting?: AwaitingHint;
}

interface CloseOutcome {        // complex / close + autoclose
  multiplier: number;
  ops: Op[];
  type: string;
  carry?: CarryState;
  nextMode?: string;
}
```

`Op` is `unknown` to core. Math owns the format; the client knows the
format. Core forwards untouched.

### Breaking-change policy

- Adding a new optional field to `MathModule` or its outcomes is non-breaking.
- Adding a new required field is breaking.
- Renaming a field is breaking.
- Removing a field is breaking.

Breaking changes go through deprecation in `0.X` and become permanent in
`0.X+1`. Post-1.0, breaking changes wait for a major bump.

## 2. PlatformAdapter

```ts
interface PlatformAdapter {
  connect(): Promise<void>;
  disconnect(): void;
  readonly isHealthy: boolean;
  readonly diagnostics: Record<string, unknown>;

  openSession(sessionId: string, connectionId: string): Promise<SessionInfo>;

  settleSimple(req: SettleSimple): Promise<RoundReceipt>;

  openComplex(req: OpenComplex): Promise<RoundReceipt>;
  updateComplex?(req: UpdateComplex): Promise<void>;     // audit-only, optional
  closeComplex(req: CloseComplex): Promise<RoundReceipt>;

  onEvent(handler: (e: PlatformEvent) => void): void;
}
```

### Money-movement contract

Every implementation MUST guarantee:

- `settleSimple` is the ONLY money-mover for simple rounds (one debit +
  credit atomically).
- `openComplex` debits the bet; `closeComplex` credits the win.
- `updateComplex` NEVER moves money — it is pure audit/state-persistence
  for jurisdictions that require server-side action logs.
- `PlatformEvent` notifications are best-effort but the wallet is the
  source of truth — RGS treats local balance as a cache.

### PlatformEvent

```ts
type PlatformEvent =
  | { type: "balanceChanged"; sessionId; balance; reason }
  | { type: "sessionClosed"; sessionId; reason }
  | { type: "promoGranted"; sessionId; promo: PromoFreeRounds }
  | { type: "autocloseRequested"; sessionId; roundId?; reason }
```

Adapters MAY emit additional event variants in the future; consumers
MUST treat unknown types as no-ops, not errors.

### Error translation

Wallet adapters translate native error codes into the canonical
`RGSErrorCode` vocabulary at the boundary. The orchestrator never sees
`"InsufficientFunds"` — only `"INSUFFICIENT_BALANCE"`.

## 3. ClientTransport

```ts
interface ClientTransport {
  start(api: OrchestratorAPI): Promise<{ port: number }>;
  stop(): void;
}
```

Transport is encoding-only. Receives bytes (or strings) from the client,
decodes them into typed requests, calls the corresponding `OrchestratorAPI`
method, encodes the response back. No business logic.

The reference implementation is binary-MessagePack-over-WS. Alternative
implementations (JSON-WS, REST, gRPC) are encouraged. They share the
same `OrchestratorAPI` so swapping is transparent to core.

## 4. GameManifest

```ts
interface GameManifest {
  id: string;
  declaredRtp: number;
  modes: Record<string, GameMode>;
  defaultMode: string;
  autoclose?: { idleMs: number } & AutoclosePolicy;   // hint, not timer
  recovery?: RecoveryPolicy;
}

interface GameMode {
  math: MathModule;
  stakeMultiplier: number;
  label?: string;
  internal?: boolean;       // cannot be requested by client; only via nextMode
  declaredRtp?: number;
}
```

Built via the `defineGame()` helper, which validates basic invariants:

- `defaultMode` exists in `modes`.
- All `stakeMultiplier` values are non-negative numbers.
- Frozen at creation time (immutable).

Future validation (planned, not yet enforced): every `nextMode` value
that any math could emit must resolve to a mode in this manifest. We
don't know it until we look at the math, so it's a runtime check.

## 5. OrchestratorAPI

```ts
interface OrchestratorAPI {
  init(req, conn): Promise<ClientResponseInit>;
  spin(req, conn): Promise<ClientResponseSpin>;
  openRound(req, conn): Promise<ClientResponseOpenRound>;
  stepRound(req, conn): Promise<ClientResponseStepRound>;
  closeRound(req, conn): Promise<ClientResponseCloseRound>;
  promoAccept(req, conn): Promise<ClientResponsePromoAccept>;
  autocloseRound(req: AutocloseRequest): Promise<AutocloseResponse>;
  onDisconnect(conn): void;
}
```

This is what transports drive. It is also what the admin HTTP layer
calls for `POST /api/autoclose`. Tests can drive it directly without
either transport or admin.

## Acceptance criteria

- The `@open-rgs/contract` package compiles with zero deps and zero
  runtime code (types-only).
- A `MathModule` implementation can be unit-tested without the
  orchestrator, wallet, or transport.
- A `PlatformAdapter` implementation can be unit-tested by emitting
  `PlatformEvent`s and asserting orchestrator state via the public API.
- A `ClientTransport` implementation can be tested by handing it a fake
  `OrchestratorAPI` and asserting frame-level behaviour.

## Open questions

- Should `view(state)` be added to `ComplexMath` for public-state
  projection (so simulator strategies can't cheat)? Currently every
  field of `RoundState` is opaque to core, but a strategy that gets
  the raw blob could see hidden info. **Decision pending.**
- Should `MathModule` declare `parameters` (tunable knobs) for the
  optimizer? Currently parameters are baked into the source.
  **Decision pending.**
- Should `nextMode` be replaced by a `transitions: { fromMode → toMode }`
  table on the manifest, with math emitting transition tags instead of
  destination mode names? Would catch typos at manifest-validate time.
  **Decision pending.**
