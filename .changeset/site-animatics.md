---
"@open-rgs/core": patch
---

Docs: every library route now carries three animatics and a syntax-coloured
code sample, and a new `/extension/build-a-slot` walks the whole set end to end
in eight steps.

62 animatics across 46 distinct kinds, up from 13. Each shows the idea a page
turns on rather than repeating the prose: the fifth cell that exists in a tall
reel and not a short one, a pointer landing in weighted bands, a wild counted in
both clusters it touches, a respin counter resetting rather than decrementing.

Colouring is a small regex tokeniser rather than a highlighter dependency -
these samples are short and TypeScript-only, and shipping a highlighter to
colour twenty lines is not a trade worth making.
