---
"@open-rgs/core": patch
---

Admin handler now matches each canonical route in BOTH the prefixed
(`adminRouteBasePath + route`) and the bare (`route`) shape when
`adminRouteBasePath` is configured.

Why: a public ingress that mounts admin under `/api/<service>/*` and
forwards without rewriting sends the prefixed path, while k8s
livenessProbe/readinessProbe and the Docker HEALTHCHECK hit the pod
IP directly with the bare path. Previously you had to pick one  - now
both work from the same image. Matching is still EXACT (`===`) for
both shapes, so the `/wss/admin/autoclose` suffix-injection hole the
audit closed stays closed.
