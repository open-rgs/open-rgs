// The RNG seam, shared by every math loader.
//
// Randomness is INJECTED, never ambient: a loader resolves one generator here
// and hands it to the math as `host.rng_next`. Keeping the policy in one place
// is what makes "math cannot bypass the auditable RNG" a property of the system
// rather than a convention each loader re-implements.

import { webcrypto } from "node:crypto";
import { log } from "./log.js";

/** Cryptographically-secure default RNG, backed by the system CSPRNG (Bun /
 *  Node WebCrypto -> BoringSSL/OpenSSL `RAND_bytes`, the same source Bun's
 *  `crypto` uses). Returns a uniform 53-bit float in `[0, 1)`. This is
 *  open-rgs's secure default for outcome determination  - unpredictable and
 *  unseedable, unlike `Math.random` (V8 xorshift128+).
 *
 *  It is a CSPRNG, NOT necessarily a *certified/auditable* RNG (no seed-commit
 *  or consumed-value log). Jurisdictions that mandate a certified source should
 *  inject their approved RNG via `loadTsMath({ rng })`. */
export function cryptoRng(): number {
  const u = new Uint32Array(2);
  webcrypto.getRandomValues(u);
  // 53 random bits: all 32 of u[0] shifted up by 21, plus the top 21 of u[1].
  return (u[0]! * 0x20_0000 + (u[1]! >>> 11)) / 0x20_0000_0000_0000;
}

/** Resolve the math RNG. Defaults to the secure system CSPRNG ({@link
 *  cryptoRng})  - never `Math.random`. In production with no injected rng we
 *  fail closed (throw) so the operator chooses its certified/approved source
 *  consciously rather than us picking silently. */
/** Resolve the math RNG. Defaults to the secure system CSPRNG ({@link
 *  cryptoRng})  - never `Math.random`. In production with no injected rng we
 *  fail closed (throw) so the operator chooses its certified/approved source
 *  consciously rather than us picking silently. */
export function resolveRng(
  path: string,
  opts: { rng?: () => number; allowInsecureRng?: boolean } | undefined,
  who = "loadTsMath",
): () => number {
  const isProduction = process.env["NODE_ENV"] === "production";
  if (opts?.rng) {
    // Reject a simulator-only PRNG (e.g. mulberry32) for production outcome
    // determination  - it's reproducible and predictable (see audit H8).
    const tagged = (opts.rng as { __insecureSimulatorRng?: boolean }).__insecureSimulatorRng;
    if (isProduction && tagged && !opts.allowInsecureRng) {
      throw new Error(
        `${who}(${path}): the injected rng is a simulator-only PRNG ` +
        `(mulberry32 or similar)  - non-cryptographic and predictable, not for ` +
        `real-money outcome determination. Inject a certified CSPRNG, or pass ` +
        `{ allowInsecureRng: true } for non-real-money tooling only.`,
      );
    }
    return opts.rng;
  }
  if (isProduction && !opts?.allowInsecureRng) {
    throw new Error(
      `${who}(${path}): no rng provided. A production RGS must choose its ` +
      `outcome RNG consciously  - pass { rng: cryptoRng } to use the secure system ` +
      `CSPRNG (WebCrypto -> BoringSSL), or inject a certified/approved source. ` +
      `(We refuse to default silently in production, even to a secure CSPRNG; ` +
      `outside production cryptoRng is the default. { allowInsecureRng: true } ` +
      `permits the default for non-real-money tooling.)`,
    );
  }
  log.warn(`${who}: no rng injected  - defaulting to the system CSPRNG ` +
    `(cryptoRng / WebCrypto -> BoringSSL). Secure and unpredictable, but not a ` +
    `certified/auditable source  - inject your approved RNG for real-money ` +
    `certification.`, {
    "event.category": "process",
    "event.action": "rng_crypto_default",
    "math.path": path,
  });
  return cryptoRng;
}
