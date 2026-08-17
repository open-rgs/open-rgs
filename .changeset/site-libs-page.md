---
"@open-rgs/core": patch
---

Docs: new `/libs` page covering the `@open-rgs/*` slot libraries - the three
signatures every piece shares, the layer stack, a complete worked game, an
extension guide, and the package surface.

Includes four looped CSS animatics for the rules that are easy to state and
easy to implement wrongly: cascade gravity being per-column, stickiness moving
clumping without moving frequency, a wild belonging to every cluster it
touches, and a hold-and-win landing resetting the respin counter rather than
decrementing it. Square divs, no rounded corners, no external library - CSS
keyframes are what looped div animation is for, and they respect
`prefers-reduced-motion`.
