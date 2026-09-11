---
"@open-rgs/adapter-artube": minor
---

Artube adapter: complex rounds, platform autoclose, and major-unit amounts.

`openComplex` / `updateComplex` / `closeComplex` threw — the adapter served
simple-round games only. They are now `OpenRoundRequest` /
`UpdateRoundStateRequest` / `CloseRoundRequest`, with the platform's
`round_version` tracked per round (it is computed wallet-side, and a stale one
is refused with `InvalidRoundOperation`).

An `AutocloseRequestEvent` surfaces as `PlatformEvent{type:"autocloseRequested"}`,
and the close the orchestrator answers it with goes back out as
`AutocloseRoundRequest` rather than a plain close.

Two fixes that were latent before complex rounds made them urgent:

- **Amounts.** Artube states money in major units (`150.75`); open-rgs counts
  integer minor units and refuses a fractional bet. An unconverted
  `allowed_bets: [0.10, 0.25]` failed every round with `INVALID_BET`. Inbound
  amounts are now scaled by `game_settings.currency_minimal_unit` (or
  `currencyDecimals`). `amountScaling: "verbatim"` opts out.
- **Events.** `BalanceChangedEvent` and friends were only matched without the
  `Event` suffix; both spellings appear in Artube's docs and the suffixed ones
  were being dropped as unknown types.

`previous_round_id` is not sent. It chains a round to the one it continues and
the platform validates the link, so guessing it from the last round the adapter
closed fails every open that follows a simple settle - found against the
sandbox, and the fake server now models the refusal.

Also: a close carries both the round's final state and the next round's carry
into one wallet slot via a marked envelope (unmarked strings still read back
verbatim); features are read from a `$features` key in the math's own state and
sent as the open ∪ close union; and `schemaVersion: 2` opts into the
per-contract Hello declaration.
