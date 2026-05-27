// @open-rgs/platform-mock
//
// In-memory PlatformAdapter for development and testing. Holds balances per
// session, settles rounds locally, and supports optional promo-free-rounds
// injection so you can exercise the promo code path without a real upstream.

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

export class MockPlatform implements PlatformAdapter {
  private state = new Map<string, MockState>();
  private handlers: ((e: PlatformEvent) => void)[] = [];
  private roundCounter = 0;
  private connected = false;

  constructor(private readonly opts: MockPlatformOptions = {}) {}

  // ─── lifecycle ────────────────────────────────────────────────────────

  async connect(): Promise<void> { this.connected = true; }
  disconnect(): void { this.connected = false; }
  get isHealthy(): boolean { return this.connected; }
  get diagnostics(): Record<string, unknown> {
    return {
      connected: this.connected,
      sessions: this.state.size,
      rounds_settled: this.roundCounter,
    };
  }

  onEvent(h: (e: PlatformEvent) => void): void { this.handlers.push(h); }
  private emit(e: PlatformEvent): void { for (const h of this.handlers) h(e); }

  // ─── session ──────────────────────────────────────────────────────────

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

  // ─── simple round ─────────────────────────────────────────────────────

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const s = this.must(req.sessionId);
    const isPromo = Boolean(req.promoId);
    if (!isPromo) {
      if (req.bet > s.balance) throw new Error("InsufficientFunds");
      s.balance -= req.bet;
    }
    s.balance += req.win;
    this.roundCounter++;
    const roundId = this.nextRoundId();

    const receipt: RoundReceipt = { roundId, balance: s.balance };
    if (s.promo && isPromo && s.promo.id === req.promoId) {
      s.promo.remaining = Math.max(0, s.promo.remaining - 1);
      receipt.promo = { remaining: s.promo.remaining };
      if (s.promo.remaining === 0) s.promo = undefined;
    }
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "spin" });
    return receipt;
  }

  // ─── complex round ────────────────────────────────────────────────────

  async openComplex(req: OpenComplex): Promise<RoundReceipt> {
    const s = this.must(req.sessionId);
    const isPromo = Boolean(req.promoId);
    if (!isPromo) {
      if (req.bet > s.balance) throw new Error("InsufficientFunds");
      s.balance -= req.bet;
    }
    const roundId = this.nextRoundId();
    s.openRound = { roundId, bet: req.bet };
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "open" });
    return { roundId, balance: s.balance };
  }

  async updateComplex(_req: UpdateComplex): Promise<void> {
    /* audit-only no-op for the mock */
  }

  async closeComplex(req: CloseComplex): Promise<RoundReceipt> {
    const s = this.must(req.sessionId);
    if (!s.openRound || s.openRound.roundId !== req.roundId) {
      throw new Error("InvalidRoundOperation: roundId mismatch");
    }
    s.balance += req.win;
    s.openRound.finalState = req.finalState;
    s.openRound = undefined;
    this.roundCounter++;
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "close" });
    return { roundId: req.roundId, balance: s.balance };
  }

  // ─── helpers ──────────────────────────────────────────────────────────

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
    return `r-${Date.now().toString(36)}-${(this.roundCounter).toString(36)}`;
  }
}
