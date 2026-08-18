// A canonical op vocabulary.
//
// `Op` is deliberately `unknown` in the core contract: math authors define
// their own visual instructions and the engine only forwards them. That is the
// right default and it is not changing. The cost is that every client is
// bespoke - nothing generic can render a game it has never seen, which makes
// smoke tests, replay tools and integration harnesses game-specific too.
//
// This module is the opt-in middle ground. A game that emits these shapes can
// be driven by any client that understands them, including
// `@open-rgs/client`'s universal renderer. A game that does not is unaffected:
// nothing in the engine reads or validates ops, and this file is types plus a
// type guard, with no runtime cost unless you call it.
//
// The vocabulary covers what a slot actually needs to say, and stops there:
//
//   board      here is a grid of symbols
//   win        these cells paid this much
//   cascade    these cells cleared and the board fell
//   respin     the lock-and-spin counter changed
//   coin       a coin landed, or its value changed
//   award      a jackpot or feature award landed
//   feature    a feature started or ended
//   meter      a named counter moved
//   message    say this to the player
//
// It is a VISUAL log, not a settlement record. `multiplier` on the round is
// what pays; an op saying `amount: 250` is describing what to draw. Divergence
// between the two is a presentation bug, never a money one, because nothing
// downstream of the client reads these.

/** Every canonical op carries a `kind`, so a client can switch on one field. */
export interface BaseOp {
  readonly kind: string;
}

/** The board as the player should see it now.
 *
 *  `cells` is column-major and flat, matching how a ragged grid is stored:
 *  column 0's cells first, then column 1's. `shape` gives the height of each
 *  column, so a client can lay out a variable-height board without guessing. */
export interface BoardOp extends BaseOp {
  readonly kind: "board";
  readonly shape: readonly number[];
  readonly cells: readonly string[];
  /** Which board this is, when a round shows several: the opening draw, a
   *  cascade step, a respin frame. */
  readonly stage?: string;
}

/** Cells that paid, and what they paid.
 *
 *  `cells` are flat indices into the matching `BoardOp`, so a client can
 *  highlight them without re-deriving any geometry. */
export interface WinOp extends BaseOp {
  readonly kind: "win";
  readonly symbol: string;
  readonly count: number;
  /** Multiple of bet. */
  readonly amount: number;
  readonly cells: readonly number[];
  /** Payline index, for line wins. */
  readonly line?: number;
  /** Number of ways, for ways wins. `amount` already includes it. */
  readonly ways?: number;
}

/** One tumble: these cells cleared, and the board that followed. */
export interface CascadeOp extends BaseOp {
  readonly kind: "cascade";
  /** 1-based step within this round. */
  readonly step: number;
  readonly cleared: readonly number[];
  /** Ladder value applied to this step's own win. */
  readonly multiplier?: number;
}

/** The respin counter moved. `reset: true` distinguishes a landing that
 *  refilled the counter from a blank spin that burned one, which is the whole
 *  feel of a hold-and-win. */
export interface RespinOp extends BaseOp {
  readonly kind: "respin";
  readonly left: number;
  readonly reset?: boolean;
}

/** A coin landed, or an existing one changed value. `tier` is set when the
 *  coin is a jackpot rather than a cash value. */
export interface CoinOp extends BaseOp {
  readonly kind: "coin";
  readonly cell: number;
  /** Multiple of bet. Absent when the coin carries a tier instead. */
  readonly amount?: number;
  readonly tier?: string;
  /** What changed it, when it was not a fresh landing: "collect", "add",
   *  "multiply", "upgrade", "spawn". */
  readonly cause?: string;
}

/** A jackpot or feature award. */
export interface AwardOp extends BaseOp {
  readonly kind: "award";
  /** Multiple of bet. */
  readonly amount: number;
  /** "MINI", "GRAND", "full-board", whatever the game calls it. */
  readonly label?: string;
}

/** A feature began or finished. */
export interface FeatureOp extends BaseOp {
  readonly kind: "feature";
  readonly name: string;
  readonly phase: "start" | "end";
  /** Free spins granted, respins granted, whatever the count means here. */
  readonly count?: number;
}

/** A named counter moved: a progress meter, a running multiplier, spins left. */
export interface MeterOp extends BaseOp {
  readonly kind: "meter";
  readonly name: string;
  readonly value: number;
  readonly max?: number;
}

/** Something to show the player. Not an error - errors travel as errors. */
export interface MessageOp extends BaseOp {
  readonly kind: "message";
  readonly text: string;
  readonly level?: "info" | "win" | "warn";
}

export type CanonicalOp =
  | BoardOp | WinOp | CascadeOp | RespinOp
  | CoinOp | AwardOp | FeatureOp | MeterOp | MessageOp;

const KINDS = new Set([
  "board", "win", "cascade", "respin", "coin", "award", "feature", "meter", "message",
]);

/**
 * Is this op one a generic client can render?
 *
 * Shape-checks the discriminant and the fields a renderer would dereference,
 * so a client can mix canonical and game-specific ops in one stream and route
 * each without a try/catch. It is not a validator: a game emitting nonsense
 * inside a well-shaped op is the game's problem, and no client-side check
 * would make that safe anyway.
 */
export function isCanonicalOp(op: unknown): op is CanonicalOp {
  if (typeof op !== "object" || op === null) return false;
  const o = op as Record<string, unknown>;
  if (typeof o["kind"] !== "string" || !KINDS.has(o["kind"])) return false;

  switch (o["kind"]) {
    case "board":
      return Array.isArray(o["shape"]) && Array.isArray(o["cells"]);
    case "win":
      return typeof o["symbol"] === "string"
        && typeof o["amount"] === "number"
        && Array.isArray(o["cells"]);
    case "cascade":
      return typeof o["step"] === "number" && Array.isArray(o["cleared"]);
    case "respin":
      return typeof o["left"] === "number";
    case "coin":
      return typeof o["cell"] === "number";
    case "award":
      return typeof o["amount"] === "number";
    case "feature":
      return typeof o["name"] === "string"
        && (o["phase"] === "start" || o["phase"] === "end");
    case "meter":
      return typeof o["name"] === "string" && typeof o["value"] === "number";
    case "message":
      return typeof o["text"] === "string";
    default:
      return false;
  }
}

/** Keep only the ops a generic client understands, in order. A game mixing its
 *  own ops in stays renderable; the unknown ones are simply not drawn. */
export function canonicalOps(ops: readonly unknown[]): CanonicalOp[] {
  return ops.filter(isCanonicalOp);
}

/** Total of every `win` and `award` in a stream, as a multiple of bet.
 *
 *  For CHECKING a presentation against the round's settled multiplier, not for
 *  paying anything. A mismatch means the visual log disagrees with what was
 *  paid, which is worth catching in a test and is never a reason to move money. */
export function opsTotal(ops: readonly unknown[]): number {
  let n = 0;
  for (const op of canonicalOps(ops)) {
    if (op.kind === "win" || op.kind === "award") n += op.amount;
  }
  return n;
}
