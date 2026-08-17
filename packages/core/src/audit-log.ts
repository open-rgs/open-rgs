// Durable, append-only, tamper-evident game-outcome log.
//
// GLI-19 and most jurisdictions require the game-outcome determination to be
// logged in a reconstructable, tamper-evident form. The wallet only sees an
// opaque round_state + a multiplier/type, so it cannot detect rigged math or
// reconstruct how an outcome arose  - that auditing is an RGS responsibility.
//
// This module records one event per money-moving round (settle / open /
// close / autoclose), hash-chained: each event's `hash` covers the previous
// event's hash plus the event's own fields, so any later edit or deletion
// breaks the chain (verifiable with verifyChain). Each event carries the
// math's content hash, so an auditor can prove which math version produced a
// given outcome. Events stream to a pluggable AuditSink  - the in-repo sinks
// are for dev/tests; a production deployment wires a durable, append-only
// sink (file with fsync, object storage, Kafka, ...) with its own retention.
//
// Reconstructability of the RNG draws themselves is the injected RNG's
// responsibility (a certified RNG keeps a tamper-evident log of consumed
// values, or a seed-commit scheme  - see Spec 03 / audit C5). This log makes
// the *outcome* and the *math identity* tamper-evident and durable.

import { createHash } from "node:crypto";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

/** The engine's named verdict on a round's money  - the No-Money-No-Honey
 *  taxonomy (Guarantee 1). Independent of the math's free-form outcome `type`,
 *  it gives the audit log an explicit money-outcome lifecycle (opened / settled
 *  / failed / autoclosed / rejected) so an auditor reads one vocabulary.
 *
 *  - `opened`        - complex round's debit recorded; win still pending.
 *  - `settled`       - money moved normally (a simple settle, or a complex close).
 *  - `settled-max-win`  - settled, but the win hit the max-win cap (Guarantee 7).
 *  - `failed-bet`    - the bet was declined / the open failed; NO money moved and
 *                     NO state was kept. This is No-Money-No-Honey, logged.
 *  - `failed-win`    - the win credit failed after the bet was taken (a wallet
 *                     fault mid-round); flagged for reconciliation.
 *  - `autoclosed`    - the round was closed by an external autoclose trigger.
 *  - `rejected`      - the round was refused before any money moved. */
export type RoundOutcomeStatus =
  | "opened"
  | "settled"
  | "settled-max-win"
  | "failed-bet"
  | "failed-win"
  | "autoclosed"
  | "rejected";

export interface AuditEvent {
  /** Which chain this event belongs to. Sequence numbers and `prevHash` links
   *  are only meaningful WITHIN one chain: a restart or a second instance
   *  starts a new one. A collector partitions by this before verifying. */
  chainId?: string;
  /** Monotonic per-chain sequence (1-based). */
  seq: number;
  /** Epoch ms when recorded. */
  ts: number;
  sessionId: string;
  roundId: string;
  kind: "settle" | "open" | "step" | "close" | "autoclose";
  /** Outcome type tag from math (e.g. "win", "loss", "max_win_reached"). */
  type: string;
  /** Named round-outcome status  - the engine's verdict on what happened to the
   *  money, independent of the math's free-form `type`. Makes the No-Money-No-
   *  Honey principle auditable: a declined bet logs `failed-bet` with win=0 and
   *  is never a `settled`. See specs/00-guarantees.md (Guarantee 1) and the
   *  RoundOutcomeStatus vocabulary. Optional for back-compat with hand-built
   *  AuditInput; defaults to "settled" when omitted. */
  outcomeStatus?: RoundOutcomeStatus;
  bet: number;
  win: number;
  multiplier: number;
  mathName: string;
  mathVersion: string;
  /** SHA-256 of the math source  - proves which math produced this outcome. */
  mathContentHash: string;
  /** Autoclose trigger reason, when kind === "autoclose". */
  reason: string;
  /** Hash of the previous event (genesis for the first). */
  prevHash: string;
  /** SHA-256 over (prevHash + the ordered fields above). */
  hash: string;
}

export type AuditInput = Omit<AuditEvent, "chainId" | "seq" | "ts" | "prevHash" | "hash">;

/** Where audit events are durably written. `append` must not throw into the
 *  caller  - a durable sink buffers/retries internally. */
export interface AuditSink {
  append(event: AuditEvent): void;
}

export interface AuditLog {
  /** Record one event, computing seq / prevHash / hash and appending to the
   *  sink. `now` is injected for deterministic timestamps in tests. */
  record(input: AuditInput, now: number): AuditEvent;
}

/** The exact field order hashed  - changing this order is a breaking change to
 *  the chain format. */
function hashEvent(prevHash: string, e: Omit<AuditEvent, "hash">): string {
  const ordered = [
    e.seq, e.ts, e.sessionId, e.roundId, e.kind, e.type,
    e.bet, e.win, e.multiplier, e.mathName, e.mathVersion, e.mathContentHash, e.reason,
    // Appended at the tail so existing field positions are unchanged. Defaulted
    // here so an event written without an explicit status hashes identically to
    // one stamped "settled"  - back-compat for hand-built AuditInput.
    e.outcomeStatus ?? "settled",
    // Same rule for the chain id: absent hashes as "", so an event written
    // before chains were named verifies unchanged.
    e.chainId ?? "",
  ];
  return createHash("sha256").update(prevHash + "\n" + JSON.stringify(ordered)).digest("hex");
}

/** Options for a chain.
 *
 *  CHAIN IDENTITY. `seq` and `prevHash` live in this process. A restart, or a
 *  second instance, starts a SECOND chain at sequence 1 - so `verifyChain` over
 *  a log merged from several instances fails unless the reader splits it by
 *  chain first. That is not a defect in the hashing; it is what per-process
 *  state means. `chainId` makes the split possible: it is stamped on every
 *  event, so a collector can partition by it, and it is folded into the genesis
 *  so two chains cannot be spliced together undetected. Pass the instance id
 *  (createServer's `instanceId`, the pod name) and keep the boot in it if the
 *  sink appends across restarts. */
export interface AuditLogOptions {
  genesisHash?: string;
  /** Identity of THIS chain. Stamped on every event and folded into the
   *  genesis hash. Defaults to a per-process random id. */
  chainId?: string;
}

export function createAuditLog(sink: AuditSink, opts?: AuditLogOptions): AuditLog {
  let seq = 0;
  const chainId = opts?.chainId ?? `chain-${crypto.randomUUID()}`;
  let prevHash = opts?.genesisHash
    ?? (opts?.chainId
      // Fold the chain id into the genesis so events from two chains cannot be
      // read as one intact sequence.
      ? createHash("sha256").update(AUDIT_GENESIS_HASH + "\n" + opts.chainId).digest("hex")
      : AUDIT_GENESIS_HASH);
  return {
    record(input, now) {
      seq += 1;
      // Store an explicit status so persisted events are self-describing
      // (hashEvent applies the same default, so this doesn't change the hash).
      const withoutHash: Omit<AuditEvent, "hash"> = {
        ...input, outcomeStatus: input.outcomeStatus ?? "settled", chainId, seq, ts: now, prevHash,
      };
      const hash = hashEvent(prevHash, withoutHash);
      const event: AuditEvent = { ...withoutHash, hash };
      prevHash = hash;
      sink.append(event);
      return event;
    },
  };
}

/** Verify a chain of events is intact: correct linkage + correct hashes.
 *  Returns the index of the first broken event, or -1 if the chain is whole. */
export function verifyChain(events: readonly AuditEvent[], genesisHash = AUDIT_GENESIS_HASH): number {
  let prevHash = genesisHash;
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.prevHash !== prevHash) return i;
    const { hash, ...rest } = e;
    if (hashEvent(prevHash, rest) !== hash) return i;
    prevHash = hash;
  }
  return -1;
}

/** In-memory ring sink  - for dev/tests. NOT durable. */
export function memoryAuditSink(capacity = 10_000): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    append(e) {
      events.push(e);
      if (events.length > capacity) events.shift();
    },
  };
}

/** JSONL-to-stdout sink  - one event per line. Pipe stdout to a durable,
 *  append-only collector. (Still not fsync-durable on its own.) */
export function jsonlStdoutAuditSink(): AuditSink {
  return {
    append(e) {
      process.stdout.write(JSON.stringify(e) + "\n");
    },
  };
}
