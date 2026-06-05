---
"@open-rgs/simulator": minor
---

feat(simulator): shard big runs across cores with `--shards N`

`open-rgs-sim --shards N` splits a run across N independently-seeded worker processes (one per core) and merges the per-shard reports — near-linear speedup for large certification runs. The merge (new exported `mergeReports`) is **exact** for the cert-critical numbers: measured RTP, standard error, 95% CI, verdict, hit rate, outcome-type/next-mode counts, RTP contributions, deviations, and the multiplier mean / stdDev (pooled population variance) / min / max. Only the distribution percentiles (multiplier + observation p50..p99) are count-weighted across shards and flagged via a new optional `SimulationReport.sharded` field. Sharding requires the manifest module to export a factory `({ seed }) => GameManifest` so each shard draws an independent RNG substream; a static manifest is refused (it would replay the identical stream — a fail-closed safeguard against an over-confident result).
