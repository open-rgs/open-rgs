---
"@open-rgs/contract": minor
"@open-rgs/core": minor
"@open-rgs/adapter-artube": minor
---

Close the gaps between "the rounds work" and "a real game could ship on this".

**Idempotency, on a wire that has no idempotency field.** The same key now
settles once per process — claimed before the request goes out, so concurrent
duplicates collapse to one payment rather than racing, and scoped per session so
one player's key cannot suppress another's. An unanswered settle is *checked*
rather than retried blind: the key rides inside the round state, so the adapter
reads the session's last round back and asks whether its own settle landed.
Found it, returns the real receipt; did not, the failure stands. A retry that
lands on another pod, or a wallet that is unreachable while the answer is lost,
is still not covered and is logged for reconciliation.

**Platform data reaches the client.** `SessionInfo.clientData` — an opaque,
adapter-filled, RGS-unread bag, forwarded verbatim in the INIT response. The
Artube adapter fills it with the `gamification_token` their docs say to forward
unchanged, the platform max win, auto-spin counts, RTP display settings, win
history and security hash. All of that was parsed off the wire and dropped,
which meant a real game's UI could not be built on this adapter.

**The platform's own max-win cap is visible.** `RoundReceipt.platformMaxWinReached`,
surfaced to the client as `platformMaxWin` on spin and close. Distinct from the
engine's own cap: this one is applied wallet-side and the RGS cannot infer it.

**The concurrency certification is switched on**, which is how the dedupe's
read-then-write race was found on its first run.
