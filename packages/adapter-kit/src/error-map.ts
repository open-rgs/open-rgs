// Vendor error string -> RGSErrorCode mapping. Every platform has its own
// error vocabulary; the orchestrator only speaks the contract's
// RGSErrorCode set. Adapters use an ErrorMap to bridge.
//
// Usage:
//   const errMap = new ErrorMap()
//     .when(/balance.*low/i, "INSUFFICIENT_BALANCE")
//     .when(/session.*expired/i, "SESSION_INVALID")
//     .when(/dedup/i, "INTERNAL_ERROR")
//     .otherwise("INTERNAL_ERROR");
//
//   try { ... } catch (e) { throw errMap.translate(e); }

import { RGSError, type RGSErrorCode } from "@open-rgs/contract";

type MapEntry = { match: RegExp | ((msg: string) => boolean); code: RGSErrorCode };

export class ErrorMap {
  private entries: MapEntry[] = [];
  private fallback: RGSErrorCode = "INTERNAL_ERROR";

  /** Add a rule. First match wins. */
  when(match: RegExp | ((msg: string) => boolean), code: RGSErrorCode): this {
    this.entries.push({ match, code });
    return this;
  }

  /** Fallback for unmapped errors. */
  otherwise(code: RGSErrorCode): this {
    this.fallback = code;
    return this;
  }

  /** Map a thrown thing into an RGSError. Idempotent if it already is one. */
  translate(e: unknown): RGSError {
    if (e instanceof RGSError) return e;
    const msg = e instanceof Error ? e.message : String(e);
    for (const r of this.entries) {
      const matched = r.match instanceof RegExp ? r.match.test(msg) : r.match(msg);
      if (matched) return new RGSError(r.code, msg);
    }
    return new RGSError(this.fallback, msg);
  }
}
