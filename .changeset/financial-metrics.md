---
"@open-rgs/core": minor
---

Financial metrics, aggregated in-process. New counters in the currency's
minor unit - `rgs_bets_minor_total{currency,mode,funding}` (funding=real is
the actual debit, funding=promo the notional free-round bet) and
`rgs_wins_minor_total{currency,mode,funding}` - plus `rgs_declared_rtp{mode}`
as the theoretical target line. GGR and live RTP are derived at query time
from the counters (the only way ratios aggregate correctly across a fleet).
Each instance also emits a `financial_snapshot` log line on an interval
(`financialLogIntervalMs`, default 10 min, 0 disables) with lifetime
per-currency bets/wins/GGR/RTP read straight from the in-memory counters.
`Counter` gains a `snapshot()` read-back method; bring-your-own RgsMetrics
implementations gain three required members (`betsMinor`, `winsMinor`,
`declaredRtp`).
