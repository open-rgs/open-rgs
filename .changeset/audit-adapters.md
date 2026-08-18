---
"@open-rgs/adapter-test-kit": minor
"@open-rgs/platform-mock": patch
---

The conformance suite now covers the state an adapter is the source of truth
for. `state.carry.round-trip` and `state.mathVersion.round-trip` prove that a
carry written with a settle comes back from the next `openSession` unchanged,
and that the math version comes back with it - without which the RGS cannot
tell a carry written by older math from a current one.

They found two real bugs on their first run: `MockPlatform` stored the carry
but not the math version (fixed here), and a wallet adapter in this repo wrote
`mathVersion` into one wire field and read it back from another.

`promo.consumed` checks the free-round pool when the fixture names one, and is
reported as a SKIP otherwise rather than a pass. It asserts the thing that
matters now that the engine counts down locally: a wallet may stay silent, but
a wallet that reports a number must report a shrinking one.
