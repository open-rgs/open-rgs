---
"@open-rgs/core": minor
---

Fixes from a full audit of the engine. Four of these were reproduced by
running them, not by reading them.

**A free-round pool now drains.** The contract says the engine counts the
pool down locally. It did not: the only write to `remaining` came from an
optional field on the receipt, so against a wallet whose wire has no promo
echo an accepted pool of three free rounds was a pool of unlimited free
rounds. A funded round decrements here; a wallet that reports its own number
still wins.

**A failed win credit is now in the audit log.** `failed-win` and `rejected`
were defined in `RoundOutcomeStatus` and never written, so a wallet that took
the stake at open and failed the credit at close left an `opened` event with
no terminal event - indistinguishable from a round still in flight. Both are
recorded now, including on the autoclose path.

**Both transports disclose the same thing.** The binary transport genericised
the error codes that wrap upstream detail; REST returned them verbatim, so an
internal wallet URL reached the client over one wire and not the other. The
policy moved to `error-policy.ts` and both call it. `clientMessage`,
`isOpaque` and `OPAQUE_ERROR_CODES` are exported.

**Wire payloads are validated, not cast.** `sid` becomes a session key and a
wallet argument, `params` is handed to the math; neither was ever checked to
be the type it was declared as. Both transports now run `validateRequest`
first, rejecting with `INVALID_FORMAT`.

**REST no longer locks a player out.** Its connection id was minted per
request, so every call looked like a new connection on a bound session and
`concurrencyPolicy: "reject-new"` refused everything after the first, forever.
The id derives from the session id now.

**The math is every file it is made of.** `loadTsMath` read, scanned and
hashed the entry file only, so an impure helper module passed the purity gate
and a rewritten payout table produced an identical `contentHash` - the value
the audit log carries as proof of which math computed an outcome. The loader
walks the local module graph now. It also warns when a reload cannot take
effect, rather than silently running cached helpers. `collectMathSources` and
`hashMathSources` are exported.

**Seed-expand replays the round it recorded.** The stream, the seed and the
forced-seed override were shared by every call, so two concurrent rounds drew
from a spliced stream and the recorded seed replayed neither. State is now
per call, held across awaits; `runSeeded(fn)` returns the seed with the call
it belongs to.

Also: the active-session gauge is derived from the session store rather than
accumulated (it counted every reconnect as a new session); metric label keys
are unambiguous and `Counter.snapshot()` exposes the label map directly;
`/admin/sessions` returns a summary instead of every session's carry and round
logs; the math pool sheds instead of queueing without bound; audit chains
carry a `chainId`; the request cache is cleared on eviction and keyed so two
sessions cannot collide; and `applyMaxWinCap` is exported so other tools can
agree with the engine about what a round pays.
