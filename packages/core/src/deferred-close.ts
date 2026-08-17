// Deferred close: let a SIMPLE math be finished by an explicit client call.
//
// A simple round opens and closes in one server call - `spin` computes the
// outcome, settles the money, and the round is over before the response is
// written. That is the right default, and it has one gap: if the player closes
// the tab mid-presentation, there is nothing left to come back to. The round is
// already settled, so a reconnect shows a balance that moved with no way to see
// why.
//
// Wrapping the math with `withDeferredClose` changes that. The outcome is still
// decided in one call, but the round stays OPEN until the client says it is
// finished. A player who disappears mid-feature reconnects into an open round,
// replays it, and ends it.
//
// WHAT THIS ACTUALLY DOES, said plainly: it turns the game into a complex
// round. There is no third round shape hiding here. `open` runs the simple
// math and parks the outcome; `close` pays it. That means the money moves
// TWICE - a debit when the round opens and a credit when it closes - exactly
// like any other complex round, and the adapter's whole job is to make that
// conversion a one-line toggle instead of a rewrite.
//
// The consequences of being complex are consequences you now own:
//
//   - An open round holds an outstanding debit. A player who never returns
//     leaves it open until something closes it, which is what `autoclose` is
//     for (external trigger - wallet, admin, reconciliation - never a timer
//     inside the RGS).
//   - `spin` is refused while a round is open, so a stuck round blocks play
//     until it is settled. That is the correct behaviour and it is also the
//     reason autoclose matters more with this toggle on than without it.
//
// The outcome is decided at OPEN, not at close. Nothing about when the client
// gets round to acknowledging can change what it won - so a slow client, a
// reconnect, or an autoclose all pay exactly the same amount.

import type {
  CarryState, ComplexMath, CloseOutcome, OpenOutcome, RoundOutcome, RoundState,
  SimpleMath, SpinContext, StepOutcome, PlayerAction,
} from "@open-rgs/contract";

/** Action type the client sends to finish a deferred-close round. Also the
 *  `awaiting.type` a resuming client sees, which is how a client (and the
 *  orchestrator's replay hint) recognises this kind of round. */
export const END_ROUND_ACTION = "endRound";

export interface DeferredCloseOptions {
  /** UX hint shown while the round waits to be ended. */
  prompt?: string;
}

/** The parked outcome, as stored in the round state. */
interface Parked {
  readonly m: number;
  readonly ops: unknown[];
  readonly t: string;
  readonly carry?: CarryState;
  readonly nextMode?: string;
}

function park(o: RoundOutcome): RoundState {
  const p: Parked = {
    m: o.multiplier,
    ops: o.ops as unknown[],
    t: o.type,
    ...(o.carry !== undefined ? { carry: o.carry } : {}),
    ...(o.nextMode !== undefined ? { nextMode: o.nextMode } : {}),
  };
  return JSON.stringify(p);
}

function unpark(state: RoundState): Parked {
  let p: Parked;
  try {
    p = JSON.parse(state) as Parked;
  } catch {
    throw new Error(
      "withDeferredClose: round state is not a parked outcome. This state was " +
        "not produced by this wrapper - check the mode's math has not changed " +
        "under an already-open round.",
    );
  }
  if (typeof p?.m !== "number" || !Array.isArray(p?.ops)) {
    throw new Error("withDeferredClose: parked outcome is missing its multiplier or ops");
  }
  return p;
}

/**
 * Wrap a simple math so its rounds are finished by an explicit client call.
 *
 * ```ts
 * const math = withDeferredClose(await loadTsMath("./maths/spin.ts", { rng }));
 * ```
 *
 * The returned math is a `ComplexMath`, so the manifest, the orchestrator, the
 * wire protocol and the adapter all treat it as one. Nothing else needs to
 * know.
 */
export function withDeferredClose(
  math: SimpleMath,
  opts: DeferredCloseOptions = {},
): ComplexMath {
  const awaiting = {
    type: END_ROUND_ACTION,
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
  };

  return {
    kind: "complex",
    name: math.name,
    version: math.version,
    rtp: math.rtp,
    ...(math.expected ? { expected: math.expected } : {}),
    ...(math.marks ? { marks: math.marks } : {}),
    ...(math.contentHash ? { contentHash: math.contentHash } : {}),

    async open(prev: CarryState | undefined, ctx: SpinContext): Promise<OpenOutcome> {
      const outcome = await Promise.resolve(math.play(prev, ctx));
      return {
        state: park(outcome),
        // The client gets the real ops immediately - it can render the whole
        // spin now. Only the settlement waits.
        ops: outcome.ops,
        awaiting,
      };
    },

    // No decisions to make: the outcome was decided at open. A deferred-close
    // round takes no steps, and saying so plainly beats inventing a no-op one.
    step(_state: RoundState, action: PlayerAction): StepOutcome {
      throw new Error(
        `withDeferredClose: this round takes no steps (got '${action?.type}'). ` +
          `Finish it with closeRound.`,
      );
    },

    // TRUE from the moment it opens. The round is resolvable immediately; it is
    // simply not closed until asked. Returning false here would make
    // closeRound reject with INVALID_ROUND and the round could never be
    // finished at all.
    isTerminal(): boolean {
      return true;
    },

    close(state: RoundState): CloseOutcome {
      const p = unpark(state);
      return {
        multiplier: p.m,
        ops: [],
        type: p.t,
        ...(p.carry !== undefined ? { carry: p.carry } : {}),
        ...(p.nextMode !== undefined ? { nextMode: p.nextMode } : {}),
      };
    },

    // External trigger (wallet, admin, reconciliation) settles an abandoned
    // round. It pays exactly what close would have paid, because the outcome
    // was fixed at open - a player who never came back is not penalised, and
    // one who came back late is not rewarded.
    autoclose(state: RoundState): CloseOutcome {
      return this.close(state) as CloseOutcome;
    },
  };
}

/** Is this an open round waiting only for the client to end it? Used by the
 *  orchestrator to flag a resume as a replay rather than a mid-decision
 *  reconnect. */
export function isAwaitingEndRound(awaitingType: string | undefined): boolean {
  return awaitingType === END_ROUND_ACTION;
}
