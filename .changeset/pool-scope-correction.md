---
---

Empty changeset: the `createMathPool` security-scope correction (it fails the
round closed but is NOT a portable no-DoS sandbox — killing a tight-loop runaway
via `worker.terminate()` is platform-dependent) is folded into the
`math-worker-pool` changeset. The source edits here are comment + log-message
only and need no separate changelog line. Caught pre-release by a mutation test;
the false "always kills the runaway" claim never shipped.
