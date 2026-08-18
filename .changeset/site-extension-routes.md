---
"@open-rgs/core": patch
---

Docs: `/extension` now has one route per library rather than a single page.
Each carries a short lede, a looped animatic of the rule that is easiest to get
wrong, one paragraph of why, and its API surface.

The animatics are a reusable `Anim.astro` component - square divs, no rounded
corners, CSS keyframes only, no script, and `prefers-reduced-motion` stops them.
