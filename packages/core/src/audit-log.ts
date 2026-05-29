// Durable, append-only, tamper-evident game-outcome log.
//
// GLI-19 and most jurisdictions require the game-outcome determination to be
// logged in a reconstructable, tamper-evident form. The wallet only sees an
// opaque round_state + a multiplier/type, so it cannot detect rigged math or
// reconstruct how an outcome arose — that auditing is an RGS responsibility.
//
// This module records one event per money-moving round (settle / open /
// close / autoclose), hash-chained: each event's `hash` covers the previous
// event's hash plus the event's own fields, so any later edit or deletion
// breaks the chain (verifiable with verifyChain). Each event carries the
// math's content hash, so an auditor can prove which math version produced a
// given outcome. Events stream to a pluggable AuditSink — the in-repo sinks
// are for dev/tests; a production deployment wires a durable, append-only
// sink (file with fsync, object storage, Kafka, …) with its own retention.
//
// Reconstructability of the RNG draws themselves is the injected RNG's
// responsibility (a certified RNG keeps a tamper-evident log of consumed
// values, or a seed-commit scheme — see Spec 03 / audit C5). This log makes
// the *outcome* and the *math identity* tamper-evident and durable.

import { createHash } from "node:crypto";

export const AUDIT_GENESIS_HASH = "0".repeat(64);

export interface AuditEvent {
  /** Monotonic per-log sequence (1-based). */
  seq: number;
  /** Epoch ms when recorded. */
  ts: number;
  sessionId: string;
  roundId: string;
  kind: "settle" | "open" | "close" | "autoclose";
  /** Outcome type tag from math (e.g. "win", "loss", "max_win_reached"). */
  type: string;
  bet: number;
  win: number;
  multiplier: number;
  mathName: string;
  mathVersion: string;
  /** SHA-256 of the math source — proves which math produced this outcome. */
  mathContentHash: string;
  /** Autoclose trigger reason, when kind === "autoclose". */
  reason: string;
  /** Hash of the previous event (genesis for the first). */
  prevHash: string;
  /** SHA-256 over (prevHash + the ordered fields above). */
  hash: string;
}

export type AuditInput = Omit<AuditEvent, "seq" | "ts" | "prevHash" | "hash">;

/** Where audit events are durably written. `append` must not throw into the
 *  caller — a durable sink buffers/retries internally. */
export interface AuditSink {
  append(event: AuditEvent): void;
}

export interface AuditLog {
  /** Record one event, computing seq / prevHash / hash and appending to the
   *  sink. `now` is injected for deterministic timestamps in tests. */
  record(input: AuditInput, now: number): AuditEvent;
}

/** The exact field order hashed — changing this order is a breaking change to
 *  the chain format. */
function hashEvent(prevHash: string, e: Omit<AuditEvent, "hash">): string {
  const ordered = [
    e.seq, e.ts, e.sessionId, e.roundId, e.kind, e.type,
    e.bet, e.win, e.multiplier, e.mathName, e.mathVersion, e.mathContentHash, e.reason,
  ];
  return createHash("sha256").update(prevHash + "\n" + JSON.stringify(ordered)).digest("hex");
}

export function createAuditLog(sink: AuditSink, opts?: { genesisHash?: string }): AuditLog {
  let seq = 0;
  let prevHash = opts?.genesisHash ?? AUDIT_GENESIS_HASH;
  return {
    record(input, now) {
      seq += 1;
      const withoutHash: Omit<AuditEvent, "hash"> = { ...input, seq, ts: now, prevHash };
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

/** In-memory ring sink — for dev/tests. NOT durable. */
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

/** JSONL-to-stdout sink — one event per line. Pipe stdout to a durable,
 *  append-only collector. (Still not fsync-durable on its own.) */
export function jsonlStdoutAuditSink(): AuditSink {
  return {
    append(e) {
      process.stdout.write(JSON.stringify(e) + "\n");
    },
  };
}
