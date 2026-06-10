---
"@open-rgs/adapter-test-kit": patch
---

The overspend conformance probe now drives the cost through
`priceMultiplier` (with a consistent oversized `bet`) instead of a doctored
`bet` alone. Amount-blind wallet wires - platforms that recompute the debit
from their own bet ladder and ignore wire amounts - never saw the old
probe's giant `bet`, so the check could not trip them. Every wallet shape
sees `ladder/bet x priceMultiplier` exceed the conformance balance.
