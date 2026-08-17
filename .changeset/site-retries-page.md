---
"@open-rgs/core": patch
---

Docs: a `/retries` page covering request-level idempotency, the canonical op
vocabulary and the universal client, with six animatics.

Two fixes found while writing it. The site's global `.bar` class (the footer)
collided with `Anim.astro`'s `.bar`, and its `align-items: baseline` silently
collapsed every animated gauge to zero height - the weighted-band and
scatter-count animatics had been rendering as empty boxes. The component's
class is now `.gauge`, with a note explaining why it must not reuse a global
name. And `sitemap.xml` is derived from the pages on disk instead of a
hand-kept list, which had gone stale: `/rest` and all sixteen `/extension/*`
routes were missing from it.

Also corrected a claim left over from the Lua removal. Guarantee 3 in
`specs/00-guarantees.md` said the TypeScript runtime nils `os`, `io`, `debug`,
`package` and `load*` - Lua vocabulary, and untrue of TypeScript math. It now
describes the purity gate accurately and states plainly that it is a source
scan rather than a sandbox: it catches the accident, not the adversary, and
math files are code you ship.
