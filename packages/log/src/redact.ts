// Recursive PII redaction. Drops sensitive values without dropping the
// surrounding shape — keeps logs structurally useful.

const REDACTED = "[REDACTED]";

/** Walk `obj` and replace any value at a key matching `keys` (case-insensitive)
 *  with "[REDACTED]". Returns a NEW object; input is not mutated. */
export function redactDeep(obj: unknown, keys: ReadonlySet<string>): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => redactDeep(v, keys));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keys.has(k.toLowerCase())) out[k] = REDACTED;
    else out[k] = redactDeep(v, keys);
  }
  return out;
}

/** Build a case-insensitive Set from an array of redact keys. */
export function buildRedactSet(keys: readonly string[] | undefined): ReadonlySet<string> {
  return new Set((keys ?? []).map(k => k.toLowerCase()));
}
