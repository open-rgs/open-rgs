// Request-level idempotency: a retried client call returns the FIRST call's
// response without running the round again.
//
// open-rgs already derives a stable idempotency key for the wallet, so a retry
// reaches the wallet with the same key and a compliant wallet collapses it to
// one money movement. That guarantee has a hole in it, and the hole is not
// hypothetical: it depends on the wallet. Some wallet wires have no field for
// an idempotency key at all, so no adapter for them can forward one. Against a
// wallet like that, a client retry after a timeout runs the math a second time
// and moves money a second time.
//
// This closes the hole on our side. Keyed on (session, client token), the
// orchestrator answers a repeat from cache and never touches math or the
// wallet, so the guarantee no longer depends on the wallet honouring anything.
//
// THREE THINGS THAT DECIDE WHETHER THIS IS CORRECT.
//
//   1. IN-FLIGHT COALESCING. The dangerous retry is the one that arrives while
//      the first is still running - a client that timed out at 5s against a
//      round still executing at 6s. Caching only completed responses would let
//      both run. So an entry is created BEFORE the work starts and holds the
//      promise; the second caller awaits the first rather than starting a
//      second round.
//
//   2. ONLY SUCCESSES ARE KEPT. A failure is cleared from the cache, because
//      the honest answer to "your spin failed with PLATFORM_UNAVAILABLE, here
//      it is again forever" is that the client should be able to retry for
//      real. Caching failures would turn a transient wallet blip into a
//      permanently poisoned key.
//
//   3. SCOPED BY SESSION. Keys are client-supplied, so two players could pick
//      the same one. Scoping by session makes a collision between players
//      impossible; within one session a collision is the player's own client
//      reusing a token, which is exactly what this is for.
//
// Entries expire on a TTL and the store is bounded. A retry arriving after the
// TTL runs for real - the window only needs to outlive a client's retry
// behaviour, not a session.

/** One cached call. `promise` is present from the moment work starts, so a
 *  concurrent repeat can await it rather than starting its own. */
interface Entry<T> {
  readonly promise: Promise<T>;
  readonly at: number;
}

export interface RequestCacheOptions {
  /** How long a completed response stays replayable. Default 120_000ms -
   *  comfortably longer than any sane client retry, far shorter than a
   *  session. */
  ttlMs?: number;
  /** Hard cap on stored entries, oldest evicted first. Guards a client that
   *  mints a fresh token per call from growing this without bound. Default
   *  10_000. */
  max?: number;
}

export interface RequestCache {
  /**
   * Run `fn` once for a given (scope, key), or return what the first run
   * produced or is producing.
   *
   * A `key` of undefined means the caller supplied no token, so there is
   * nothing stable to deduplicate on: `fn` runs, uncached. That is the
   * documented cost of not sending one.
   */
  run<T>(scope: string, key: string | undefined, fn: () => Promise<T>): Promise<T>;
  /** Drop every entry for a session. Called when the SESSION ends (the wallet
   *  closed it) or when it is evicted from the session cache - NOT when a
   *  connection drops. A dropped socket is the case this cache exists for: the
   *  client retries the call whose response it never saw, and it must get that
   *  response back rather than a second round. */
  clearScope(scope: string): void;
  /** Entries currently held. For metrics and tests. */
  readonly size: number;
}

export function createRequestCache(opts: RequestCacheOptions = {}): RequestCache {
  const ttlMs = opts.ttlMs ?? 120_000;
  const max = opts.max ?? 10_000;
  // Insertion-ordered, which is what makes the oldest-first eviction below a
  // single `keys().next()` rather than a scan.
  const store = new Map<string, Entry<unknown>>();

  // Length-prefixed, so no separator character can appear in a way that makes
  // two different (scope, key) pairs collide. A session id arrives from the
  // client and is not validated, so "pick a separator the id won't contain" is
  // not a property this can rely on.
  const idOf = (scope: string, key: string) => `${scope.length}:${scope}${key}`;

  function sweep(now: number): void {
    for (const [id, e] of store) {
      if (now - e.at <= ttlMs) break; // insertion order means the rest are newer
      store.delete(id);
    }
    while (store.size > max) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  return {
    run<T>(scope: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
      if (key === undefined || key === "") return fn();

      const now = Date.now();
      sweep(now);

      const id = idOf(scope, key);
      const hit = store.get(id);
      if (hit) return hit.promise as Promise<T>;

      // Store BEFORE awaiting, so a repeat arriving mid-flight coalesces onto
      // this promise instead of starting a second round.
      const promise = fn().catch((e: unknown) => {
        // A failed call must stay retryable. Dropping the entry means the next
        // attempt runs for real rather than being handed the same error back.
        store.delete(id);
        throw e;
      });
      store.set(id, { promise, at: now });
      // Evict AFTER inserting, or the store peaks one over the cap: sweep()
      // ran before this entry existed.
      while (store.size > max) {
        const oldest = store.keys().next();
        if (oldest.done || oldest.value === id) break;
        store.delete(oldest.value);
      }
      return promise;
    },

    clearScope(scope: string): void {
      const prefix = `${scope.length}:${scope}`;
      for (const id of store.keys()) {
        if (id.startsWith(prefix)) store.delete(id);
      }
    },

    get size(): number {
      return store.size;
    },
  };
}
