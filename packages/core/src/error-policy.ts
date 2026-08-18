// What a client is allowed to be told when a round fails.
//
// Some error codes carry an author-written, controlled-vocabulary message
// (INVALID_BET, INSUFFICIENT_BALANCE, ...) - safe to surface verbatim, and
// useful: the client can act on it. Others wrap whatever threw underneath: a
// math runtime error with a file path and a stack, an upstream wallet's
// response body, an internal URL. Those must not cross the wire.
//
// This lived inside the binary transport, so the REST transport - which
// translates the same errors from the same orchestrator - returned the wrapped
// message verbatim. Two wire formats disagreed about disclosure for identical
// failures. The policy belongs to the engine, not to a transport, so it lives
// here and both call it.

import type { RGSErrorCode } from "@open-rgs/contract";

/** Codes whose `message` may contain internal detail (wrapped math / upstream
 *  errors). Their client-facing message is replaced with a generic one. */
export const OPAQUE_ERROR_CODES: ReadonlySet<RGSErrorCode> = new Set<RGSErrorCode>([
  "INTERNAL_ERROR", "INIT_FAILED", "SPIN_FAILED", "OPEN_FAILED", "STEP_FAILED", "CLOSE_FAILED",
]);

/** True when this code's message must be genericized before it leaves. */
export function isOpaque(code: RGSErrorCode): boolean {
  return OPAQUE_ERROR_CODES.has(code);
}

/** The message to send for `code`. For an opaque code the real text is dropped
 *  and a reference is offered instead, so an operator can find the logged line;
 *  everything else passes through. */
export function clientMessage(code: RGSErrorCode, message: string, ref?: unknown): string {
  if (!isOpaque(code)) return message;
  return `internal error (ref: ${ref === undefined || ref === null || ref === "" ? "n/a" : String(ref)})`;
}
