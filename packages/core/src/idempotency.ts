// Idempotency keys for state-changing wallet RPCs.
//
// A key exists for exactly one reason: so a *retried* operation reuses the
// *same* key and the wallet can collapse it to a single money movement. The
// old implementation minted a fresh UUID on every call (`crypto.randomUUID`
// per RPC), so the wallet could never recognise a retry  - a timed-out then
// retried settle / open / close double-debited or double-credited.
//
// The fix is to make the key STABLE across retries by deriving it from the
// operation's identity rather than from randomness:
//
//   - Settling a known round (close / autoclose) keys on
//     (sessionId, roundId): every close path for a round  - client CLOSE,
//     an `autocloseRequested` event, the `sessionClosed` cascade, the admin
//     endpoint, or any retry of those  - produces the *identical* key, so the
//     wallet dedupes them to one credit. (This also defuses the
//     client-close-vs-autoclose race: both arrive with the same key.)
//
//   - Round-initiating calls (a simple spin, a complex open) have no
//     server-assigned round id yet, so retry-safety requires a stable token
//     from the client. When the client supplies one we derive
//     deterministically from it; otherwise we fall back to a random key
//     (best-effort, and documented as such  - a blind retry of a
//     round-initiating call without a client token cannot be deduped).
//
// Wallets MUST dedupe on this key for the guarantee to hold; see
// specs/05-platform-protocol.md.

const SEP = ":";

/** Build a deterministic idempotency key from stable identity parts.
 *  Parts are joined with ':'  - keep them collision-free (a session id, a
 *  round id, a phase tag like "close"). */
export function deriveIdempotencyKey(...parts: (string | number)[]): string {
  return parts.join(SEP);
}

/** Default random key generator. Used only as the fallback for a
 *  round-initiating call with no client-supplied token. */
export function uuidV4(): string {
  return crypto.randomUUID();
}
