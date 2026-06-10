---
"@open-rgs/core": patch
---

Baseline `rgs_platform_last_ok_timestamp_seconds` to boot time so an
instance that has not yet served a round reads as "silent since boot"
rather than "silent since the Unix epoch" in `time() - x` alert
expressions.
