---
"@open-rgs/core": patch
---

perf(core): session-cache eviction no longer snapshots and sorts the whole map on the INIT hot path

At `MAX_CACHED_SESSIONS` capacity, `put()` previously copied every session into an array, filtered, and full-sorted by `createdAt` (O(n log n) plus a large transient allocation) on every INIT. It now walks the `Map` in insertion (creation) order and drops the oldest idle sessions in O(evicted) with no allocation. Behaviour is unchanged: sessions with an open round are never evicted, and the cache is trimmed to the same low-water mark.
