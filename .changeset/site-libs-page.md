---
"@open-rgs/core": patch
---

Docs: new `/libs` page covering the `@open-rgs/*` slot libraries - the three
signatures every piece shares, what each layer settles, and how to extend it.
Kept deliberately short: the animatics carry the lessons, so the prose beside
them is a sentence or two rather than a paragraph.

Includes four looped CSS animatics for the rules that are easy to state and
easy to implement wrongly: cascade gravity being per-column, stickiness moving
clumping without moving frequency, a wild belonging to every cluster it
touches, and a hold-and-win landing resetting the respin counter rather than
decrementing it. Square divs, no rounded corners, no external library - CSS
keyframes are what looped div animation is for, and they respect
`prefers-reduced-motion`.
