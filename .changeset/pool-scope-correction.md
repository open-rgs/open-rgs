---
---

Empty changeset: the `createMathPool` security-scope correction (it fails the
round closed but is NOT a no-DoS sandbox — `worker.terminate()` can't preempt a
tight sync loop) is folded into the `math-worker-pool` changeset. The source
edits here are comment + log-message only and need no separate changelog line.
Caught pre-release by a mutation test; the false "kills the runaway" claim never
shipped.
