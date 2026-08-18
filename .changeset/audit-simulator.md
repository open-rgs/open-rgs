---
"@open-rgs/simulator": minor
---

**Measured RTP is now the RTP the engine would pay.** `simulate()` received
the whole manifest and ignored `maxWinMultiplier`, while the orchestrator
clips every settle at it - so the certification report described a game the
server does not pay. A spiky math with a 5,000x cap measured 100 here and paid
5 live.

The cap is applied per spin before anything is measured, so the distribution,
the percentiles and the RTP all describe live play. `rtp.measuredUncapped`,
`rtp.maxWinMultiplier` and `rtp.capped` report what the cap cost, because "the
cap never fired" and "the cap is carrying 4% of this game" are different facts.
`applyCap` is exported and pinned against core's own `applyMaxWinCap`.

The RTP verdict's confidence interval assumes independent spins while the same
run deliberately threads carry between them. `rtp.correlatedSpins` says when
that happened, and the markdown report prints the caveat rather than implying a
precision the data does not support.
