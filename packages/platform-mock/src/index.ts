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
  ReverseRound,
  ReverseReceipt,
  PromoFreeRounds,
  CarryState,
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

/** One settled round's pre-state, for reversal. Guarantee 2  - "One Round, One
 *  Record": a round is the balance delta AND the carry it produced, so the
 *  snapshot we keep to undo it holds BOTH. Pushed on every settle/close, popped
 *  LATEST-FIRST on reverseRound. */
interface ReversalEntry {
  roundId: string;
  /** Balance as it stood BEFORE this round settled. */
  balanceBefore: number;
  /** Carry as it stood BEFORE this round settled. */
  carryBefore: CarryState | undefined;
}

interface MockState {
  balance: number;
  currency: string;
  currencyDecimals: number;
  allowedBets: number[];
  defaultBetIndex: number;
  promo?: PromoFreeRounds;
  openRound?: { roundId: string; bet: number; finalState?: string; balanceBefore: number; carryBefore: CarryState | undefined };
  /** Cross-round carry the math threaded in (Guarantee 1  - persisted only with
   *  the money that earned it; written in the same settle that moved the win). */
  carry?: CarryState;
  /** LIFO stack of reversible settled rounds (most recent on top). */
  reversals: ReversalEntry[];
  /** roundIds already reversed  - so a repeated reverseRound is a safe no-op. */
  reversed: Set<string>;
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
  /** idempotencyKey -> reversal receipt, so a repeated reverseRound is a no-op. */
  private reverseReceipts = new Map<string, ReverseReceipt>();
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
        reversals: [],
        reversed: new Set<string>(),
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
      // The wallet is the source of truth for carry; hand back what we stored.
      ...(s.carry !== undefined ? { carry: s.carry } : {}),
    };
  }

  // --- simple round -----------------------------------------------------

  async settleSimple(req: SettleSimple): Promise<RoundReceipt> {
    const dup = this.replay(req.idempotencyKey);
    if (dup) return dup;

    const s = this.must(req.sessionId);
    assertAmount(req.bet, "bet");
    assertAmount(req.win, "win");

    // Snapshot pre-state BEFORE anything moves (Guarantee 2  - money+carry as
    // one record). A simple round opens+closes atomically, so its roundState
    // doubles as the carry it produced.
    const balanceBefore = s.balance;
    const carryBefore = s.carry;

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
    s.carry = req.roundState;        // persist carry IN the same settle (Guarantee 1)
    this.roundCounter++;
    const roundId = this.nextRoundId();
    this.pushReversal(s, roundId, balanceBefore, carryBefore);

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

    // Pre-round snapshot captured at OPEN (the round's money begins here).
    const balanceBefore = s.balance;
    const carryBefore = s.carry;

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
    // Capture pre-round state at OPEN: a complex round's money spans open->close,
    // so reversing it must restore the balance/carry from before the debit.
    s.openRound = { roundId, bet: req.bet, balanceBefore, carryBefore };

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
    const open = s.openRound;
    s.balance += req.win;
    // Carry the math threaded for the NEXT round, persisted with this close
    // (Guarantee 1). The reversal entry uses the snapshot taken at OPEN, so
    // reversing restores both the pre-debit balance and the pre-round carry.
    s.carry = req.carry;
    s.openRound = undefined;
    this.roundCounter++;
    this.pushReversal(s, req.roundId, open.balanceBefore, open.carryBefore);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: "close" });
    return this.remember(req.idempotencyKey, { roundId: req.roundId, balance: s.balance });
  }

  // --- reversal (Guarantee 2  - One Round, One Record) ---------------------

  async reverseRound(req: ReverseRound): Promise<ReverseReceipt> {
    const dupKey = req.idempotencyKey;
    if (dupKey !== undefined && this.reverseReceipts.has(dupKey)) {
      return { ...this.reverseReceipts.get(dupKey)! };
    }
    const s = this.state.get(req.sessionId);
    const noop = (reason: string): ReverseReceipt => {
      const r: ReverseReceipt = { roundId: req.roundId, balance: s?.balance ?? 0, reversed: false, reason };
      if (dupKey !== undefined) this.reverseReceipts.set(dupKey, { ...r });
      return r;
    };
    if (!s) return noop("session-not-found");
    // Already reversed -> safe no-op (reversing twice must not credit twice).
    if (s.reversed.has(req.roundId)) return noop("already-reversed");

    const top = s.reversals[s.reversals.length - 1];
    if (!top) return noop("round-not-found");
    // LATEST-FIRST: only the most recent un-reversed round may be reversed.
    // Reversing an older round would restore a snapshot predating newer rounds
    // and silently over-refund them  - the exploit this guarantee forbids.
    if (top.roundId !== req.roundId) return noop("not-latest-round");

    // Restore BOTH halves atomically from the one record.
    s.reversals.pop();
    s.balance = top.balanceBefore;
    s.carry = top.carryBefore;
    s.reversed.add(req.roundId);
    this.emit({ type: "balanceChanged", sessionId: req.sessionId, balance: s.balance, reason: `reversal:${req.reason}` });

    const receipt: ReverseReceipt = {
      roundId: req.roundId,
      balance: s.balance,
      reversed: true,
      ...(s.carry !== undefined ? { carry: s.carry } : {}),
    };
    if (dupKey !== undefined) this.reverseReceipts.set(dupKey, { ...receipt });
    return receipt;
  }

  /** Push a reversible round onto the session's LIFO stack. */
  private pushReversal(s: MockState, roundId: string, balanceBefore: number, carryBefore: CarryState | undefined): void {
    s.reversals.push({ roundId, balanceBefore, carryBefore });
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
        reversals: [],
        reversed: new Set<string>(),
      };
      this.state.set(sessionId, s);
    }
    return s;
  }

  private nextRoundId(): string {
    return `r-${++this.roundIdSeq}`;
  }
}
