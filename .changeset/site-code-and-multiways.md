---
"@open-rgs/core": patch
---

Docs fixes.

The syntax highlighter corrupted its own output. It ran one regex per token
type over the result of the last, so the string rule matched the `"c-com"`
inside a span the comment rule had just inserted, and readers saw
`<span class=<span class="c-str">"c-com"</span>>//` as literal text. Rewritten
as a single pass with alternation, so inserted markup is never re-scanned.

Comments are gone from every code sample. The prose beside a sample already
says what it does, and a comment repeating that is noise in a block meant to be
read at a glance.

The multiways animatic showed all its configurations at once. Its frame classes
were `f1`, `f2`, `f3`, which already carry the hold-and-win fill delays defined
later in the same stylesheet; the later rule won, every frame got a delay under
half a second, and they fired together. Renamed to `mwq1`..`mwq10` and extended
to ten configurations on a twelve-second loop, one visible at a time.

Arrow glyphs removed from the pages this work added: back links now read
"All extensions", and two animatics use words where they used arrows.
