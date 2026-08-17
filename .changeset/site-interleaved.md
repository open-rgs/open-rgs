---
"@open-rgs/core": patch
---

Docs: library routes are now a sequence of worked examples rather than a block
of demos above a block of text. Each example is a heading, a paragraph, the
animatic that shows what the paragraph said, and the code that does it.

Three examples per package, 48 across the set.

The multiways animatic was also wrong. It grew and shrank whole columns, which
read as artefacting and misrepresented the mechanic: a multiways board keeps the
same height however many symbols a reel holds, and the symbols resize to fill
it. It now cross-fades three real configurations - 2-3-4, 5-2-6 and 3-7-3 - with
the ways count beside each.
