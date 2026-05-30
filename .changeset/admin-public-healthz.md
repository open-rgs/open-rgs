---
"@open-rgs/core": minor
---

Add `adminPublicHealthz` (alias `publicHealthz` on `AdminConfig`) to
serve `/healthz` WITHOUT auth even when `requireAuth` is on. Same JSON
shape, same diagnostics — just no Bearer token required.

Use this when an operator dashboard or external uptime prober needs
to read `/healthz` from somewhere that can't inject a token (a
browser, a third-party prober, a CI smoke test that doesn't ship the
operator secret), and you've accepted that core/game/math versions,
uptime, session count, and platform connection state are public.
`/admin/*` is unaffected — still gated when `requireAuth` is on or a
token is configured.

For plain "is it up?" probes prefer `/readyz` (already always open,
returns 503 when the platform is down). This flag opens the rich
diagnostic too. Default false — back-compatible.
