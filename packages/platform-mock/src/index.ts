// @open-rgs/platform-mock
//
// In-memory PlatformAdapter for development and testing. Holds balances per
// session, settles rounds locally, and supports optional promo-free-rounds
// injection so you can exercise the promo code path without a real upstream.
//
// This is the wallet adapter authors copy to learn "what a correct wallet
// does", so it models the safety posture a real wallet MUST have:
//   - Idempotency: a repeated idempotencyKey returns the ORIGINAL receipt
//     and moves money at most once (a lost-response retry must not double).
//   - Monotonic round ids that never collide.
//   - Amounts are non-negative integer minor units; anything else is rejected.
//   - A promo (free-round) settle is allowed only against a non-empty pool.
// A production wallet MUST do the same  - especially the dedupe.

import type {
  PlatformAdapter,
  PlatformEvent,
  SessionInfo,
  SettleSimple,
  OpenComplex,
  UpdateComplex,
  CloseComplex,
  RoundReceipt,
  PromoFreeRounds,
} from "@open-rgs/contract";

export interface MockPlatformOptions {
  /** Default starting balance, in the currency's minimal unit (integer).
   *  E.g. 100_000 = 1000.00 EUR when currencyDecimals = 2. */
  startingBalance?: number;
  /** Currency code for new sessions; "" = demo. */
  currency?: string;
  /** Fractional digits of the currency. Default 2 (EUR/USD-like). */
  currencyDecimals?: number;
  /** Allowed bet ladder, in the currency's minimal unit (integers).
   *  Default: [20, 50, 100, 200, 500, 1000] = 0.20 .. 10.00 EUR. */
  allowedBets?: number[];
  defaultBetIndex?: number;
  /** Pre-seeded promo free-rounds pools by sessionId. */
  promos?: Record<string, PromoFreeRounds>;
}

interface MockState {
  balance: number;
  currency: string;
  currencyDecimals: number;
  allowedBets: number[];
  defaultBetIndex: number;
  promo?: PromoFreeRounds;
  openRound?: { roundId: string; bet: number; finalState?: string };
}

/** Reject anything that isn't a non-negative integer in the currency's
 *  minimal unit  - the contract's hard rule. A fractional or negative amount
 *  (e.g. an un-rounded win, or a negative settlement) must never be accepted
 *  by a wallet; it corrupts the ledger. */
function assertAmount(n: number, name: string): void {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`InvalidAmount: ${name} must be a non-negative integer minor unit, got ${n}`);
  }
}

export class MockPlatform implements PlatformAdapter {
  private state = new Map<string, MockState>();
  private handlers: ((e: PlatformEvent) => void)[] = [];
  /** idempotencyKey -> the receipt produced the first time we saw it. A
   *  repeat returns this and moves no money. */
  private receipts = new Map<string, RoundReceipt>();
  /** Monotonic, collision-free round-id source (bumped on every id-producing
   *  op, not just settles  - two opens in the same ms must not share an id). */
  private roundIdSeq = 0;
  private roundCounter = 0;
  private connected = false;

  constructor(private readonly opts: MockPlatformOptions = {}) {}

  // --- lifecycle --------------------------------------------------------

  async connect(): Promise<void> { this.connected = true; }
  disconnect(): void { this.connected = false; }
  get isHealthy(): boolean { return this.connected; }
  get diagnostics(): Record<string, unknown> {
    return {
      connected: this.connected,
      sessions: this.state.size,
      rounds_settled: this.roundCounter,
      idempotency_keys_seen: this.receipts.size,
    };
  }

  onEvent(h: (e: PlatformEvent) => void): void { this.handlers.push(h); }
  private emit(e: PlatformEvent): void { for (const h of this.handlers) h(e); }

  // --- session ----------------------------------------------------------

  async openSession(sessionId: string, _connectionId: string): Promise<SessionInfo> {
    let s = this.state.get(sessionId);
    if (!s) {
      s = {
        balance: this.opts.startingBalance ?? 100_000,
        currency: this.opts.currency ?? "FUN",
        currencyDecimals: this.opts.currencyDecimals ?? 2,
        allowedBets: this.opts.allowedBets ?? [20, 50, 100, 200, 500, 1000],
        defaultBetIndex: this.opts.defaultBetIndex ?? 2,
        promo: this.opts.promos?.[sessionId],
      };
      this.state.set(sessionId, s);
    }
    return {
      sessionId,
      currency: s.currency,
      currencyDecimals: s.currencyDecimals,
      balance: s.balance,
      allowedBets: s.allowedBets,
      defaultBetIndex: s.defaultBetIndex,
      promo: s.promo,
    };
  }

  // --- simple round -----------------------------------------------------

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;

    const s = this.must(req.sessionId);
    assertAmount(req.bet, "bet");
    assertAmount(req.win, "win");

    const isPromo = Boolean(req.promoId);
    if (isPromo) {
      this.assertPromo(s, req.promoId!);
    } else {
      // Debit = bet x priceMultiplier. The orchestrator now keeps `bet`
      // at base x clientPriceMul (integer minor units) and folds the
      // mode's stakeMultiplier into `priceMultiplier` so it rides on the
      // wire. Platforms with their own currency-precision handling
      // (a wallet et al.) recompute the debit; our mock does the same so
      // ante-style fractional debits + free-round (stake=0) modes both
      // settle correctly.
      const cost = req.bet * (req.priceMultiplier ?? 1);
      if (cost > s.balance) throw new Error("InsufficientFunds");
      s.balance -= cost;
    }
    s.balance += req.win;
    this.roundCounter++;
    const roundId = this.nextRoundId();

    const receipt: RoundReceipt = { roundId, balance: s.balance };
    if (isPromo) receipt.promo = this.consumePromo(s);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "spin" });
    return this.remember(req.idempotencyKey, receipt);
  }

  // --- complex round ----------------------------------------------------

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;

    const s = this.must(req.sessionId);
    assertAmount(req.bet, "bet");

    const isPromo = Boolean(req.promoId);
    if (isPromo) {
      this.assertPromo(s, req.promoId!);
    } else {
      // See settleSimple  - debit = bet x priceMultiplier under the new
      // stake-on-priceMul semantics.
      const cost = req.bet * (req.priceMultiplier ?? 1);
      if (cost > s.balance) throw new Error("InsufficientFunds");
      s.balance -= cost;
    }
    const roundId = this.nextRoundId();
    s.openRound = { roundId, bet: req.bet };

    const receipt: RoundReceipt = { roundId, balance: s.balance };
    if (isPromo) receipt.promo = this.consumePromo(s);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "open" });
    return this.remember(req.idempotencyKey, receipt);
  }

  async updateComplex(_req: UpdateComplex): Promise<void> {
    /* audit-only no-op for the mock */
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;

    const s = this.must(req.sessionId);
    assertAmount(req.win, "win");
    if (!s.openRound || s.openRound.roundId !== req.roundId) {
      throw new Error("InvalidRoundOperation: roundId mismatch");
    }
    s.balance += req.win;
    s.openRound.finalState = req.finalState;
    s.openRound = undefined;
    this.roundCounter++;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "close" });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: s.balance });
  }

  // --- helpers ----------------------------------------------------------

  /** Idempotency dedupe: if we've settled this key before, return a copy of
   *  the original receipt and move no money. */
  private replay(key: string | undefined): RoundReceipt | undefined {
    if (key === undefined) return undefined;
    const prev = this.receipts.get(key);
    return prev ? { ...prev, ...(prev.promo ? { promo: { ...prev.promo } } : {}) } : undefined;
  }
  private remember(key: string | undefined, receipt: RoundReceipt): RoundReceipt {
    if (key !== undefined) {
      this.receipts.set(key, { ...receipt, ...(receipt.promo ? { promo: { ...receipt.promo } } : {}) });
    }
    return receipt;
  }

  /** A promo settle is only valid against a matching, non-empty pool. */
  private assertPromo(s: MockState, promoId: string): void {
    if (!s.promo || s.promo.id !== promoId || s.promo.remaining <= 0) {
      throw new Error("InvalidRoundOperation: promo pool empty or mismatched");
    }
  }
  private consumePromo(s: MockState): { remaining: number } {
    const promo = s.promo!;
    promo.remaining = Math.max(0, promo.remaining - 1);
    const remaining = promo.remaining;
    if (remaining === 0) s.promo = undefined;
    return { remaining };
  }

  /** Test helper: grant a promo free-rounds pool to a session. */
  grantPromo(sessionId: string, promo: PromoFreeRounds): void {
    const s = this.must(sessionId, true);
    s.promo = promo;
    this.emit({ type: "promoGranted", sessionId, promo });
  }

  /** Test helper: simulate an external autoclose request. */
  requestAutoclose(sessionId: string, reason = "test", roundId?: string): void {
    this.emit({
      type: "autocloseRequested",
      sessionId,
      ...(roundId !== undefined ? { roundId } : {}),
      reason,
    });
  }

  /** Test helper: simulate the platform declaring a session closed. */
  closeSession(sessionId: string, reason = "test"): void {
    this.emit({ type: "sessionClosed", sessionId, reason });
  }

  /** Test helper: read current balance. */
  balanceOf(sessionId: string): number | undefined {
    return this.state.get(sessionId)?.balance;
  }

  private must(sessionId: string, allowMissing = false): MockState {
    let s = this.state.get(sessionId);
    if (!s) {
      if (!allowMissing) throw new Error(`SessionInvalid: ${sessionId}`);
      s = {
        balance: this.opts.startingBalance ?? 100_000,
        currency: this.opts.currency ?? "FUN",
        currencyDecimals: this.opts.currencyDecimals ?? 2,
        allowedBets: this.opts.allowedBets ?? [20, 50, 100, 200, 500, 1000],
        defaultBetIndex: this.opts.defaultBetIndex ?? 2,
      };
      this.state.set(sessionId, s);
    }
    return s;
  }

  private nextRoundId(): string {
    return `r-${++this.roundIdSeq}`;
  }
}
