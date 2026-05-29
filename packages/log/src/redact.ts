// Recursive PII/secret redaction. Drops sensitive values without dropping
// the surrounding shape  - keeps logs structurally useful.
//
// Two layers, because key-name matching alone (the old behaviour) leaked:
//   1. Key redaction  - a field whose name matches a redact key is replaced.
//      Matching is separator- and case-insensitive, so configuring
//      "session_id" (or the defaults below) also catches "session.id",
//      "sessionId", "X-Session-Id", etc.  - the near-miss keys the old exact
//      match let through.
//   2. Value scrubbing  - secrets that live in VALUES, not keys: a
//      `Bearer <token>` in a message, or `?authToken=...` / `password=...` in a
//      logged URL or string. Key matching can't catch these.
//
// Defaults target genuine credentials, not correlation ids: session/round
// ids stay readable so logs remain useful (operators can add identifiers via
// redactKeys if a jurisdiction requires it).

const REDACTED = "[REDACTED]";

/** Default redact keys  - credential/secret field names. Matched separator-
 *  and case-insensitively. */
export const DEFAULT_REDACT_KEYS: readonly string[] = [
  "password", "passwd", "pwd",
  "secret", "token", "accesstoken", "refreshtoken", "idtoken",
  "apikey", "authorization", "auth", "credential", "credentials",
  "cookie", "setcookie", "privatekey", "clientsecret",
];

/** Normalise a key for separator-insensitive comparison: lowercase and strip
 *  `_ - . space`. So "X-Auth-Token" / "auth_token" / "authToken" -> "authtoken". */
function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[_\-.\s]/g, "");
}

/** A key is sensitive if its normalised form CONTAINS any redact token  -
 *  substring, not exact, so "authToken"/"X-Auth-Token" hit via "token"/"auth"
 *  and "client_secret" via "secret". Correlation ids (session.id, round.id)
 *  contain none of the credential tokens, so they stay readable. */
function keyIsSensitive(key: string, redactSet: ReadonlySet<string>): boolean {
  const norm = normalizeKey(key);
  for (const token of redactSet) {
    if (norm.includes(token)) return true;
  }
  return false;
}

/** Build a redact set from the defaults plus any caller-supplied keys. */
export function buildRedactSet(keys: readonly string[] | undefined): ReadonlySet<string> {
  return new Set([...DEFAULT_REDACT_KEYS, ...(keys ?? [])].map(normalizeKey));
}

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// key=value where the key name contains a secret token. Value runs to the next
// query/delimiter char. Catches URL query strings and inline `password=...`.
const SECRET_PARAM_RE =
  /\b([\w.-]*(?:password|passwd|pwd|secret|token|api[_.-]?key|authorization|sig|signature|access[_.-]?token|refresh[_.-]?token|credential|cookie)[\w.-]*)=([^&\s"';]+)/gi;

/** Scrub secrets embedded in a string value (not caught by key matching). */
export function scrubString(s: string): string {
  return s.replace(BEARER_RE, "Bearer [REDACTED]").replace(SECRET_PARAM_RE, "$1=[REDACTED]");
}

/** Walk `obj`: redact values whose key matches `keys` (separator-insensitive),
 *  and scrub secrets out of every string value. Returns a NEW object; input is
 *  not mutated. */
export function redactDeep(obj: unknown, keys: ReadonlySet<string>): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return scrubString(obj);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => redactDeep(v, keys));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keyIsSensitive(k, keys)) out[k] = REDACTED;
    else out[k] = redactDeep(v, keys);
  }
  return out;
}
