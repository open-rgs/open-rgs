---
"@open-rgs/core": minor
---

Instance identity + platform SLA metrics. Every server now resolves a unique
instance id at boot (config `instanceId` > `OPEN_RGS_INSTANCE_ID` env > a
self-generated `rgs-<8 hex>`), surfaced as `rgs_build_info{instance_id,...}`
on /admin/metrics, `instance_id` in /healthz, and `service.instance.id` on
every log line - per-instance metrics, logs, and health correlate on one key.
New platform-adapter SLA series: `rgs_platform_connected` (gauge),
`rgs_platform_connection_transitions_total{direction}` (flap counter), and
`rgs_platform_last_ok_timestamp_seconds` (last successful wallet RPC - alert
on its age to catch a connected-but-silent platform). Note for bring-your-own
`RgsMetrics` implementations: the interface gains four required members
(`buildInfo`, `platformConnected`, `platformTransitions`, `platformLastOk`).
