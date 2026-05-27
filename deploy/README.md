# Reference deployment templates

This folder contains the minimum viable deployment artifacts for an
open-rgs game server. They're meant to be copied into your game repo
and adjusted, not consumed as-is.

## What you provide

A game repo with:

- `package.json` declaring `@open-rgs/core`, your wallet adapter, and
  any peer deps.
- `maths/<math-id>/play.lua` files.
- `src/index.ts` wiring `createServer({ manifest, platform, transport })`.

See `examples/` in this repo for fully-worked references.

## What this folder provides

- `docker/Dockerfile` — multi-stage Bun build that bundles your maths
  alongside the core. Production runs `bun src/index.ts` directly.
- `docker/compose.yml` — local dev stack with the mock wallet.
- `k8s/deployment.yml` — minimal Deployment + Service manifests.
- `k8s/hpa.yml` — HorizontalPodAutoscaler for CPU-driven scaling.

## Quick start (local Docker)

```bash
# from your game repo root:
docker build -t my-game -f path/to/this/docker/Dockerfile .
docker run --rm -p 8080:80 \
  -e PLATFORM_WS_URL=wss://your-platform/ws \
  my-game
```

Hit `http://localhost:8080/healthz` to verify.

## Production checklist

Before shipping to production, verify:

- [ ] `NODE_ENV=production` is set.
- [ ] Secrets are loaded from a secret manager, not bake-time env vars.
- [ ] `/livez` and `/readyz` are wired to your orchestrator's probes.
- [ ] `/admin/metrics` is scraped by Prometheus.
- [ ] Logs are shipped (JSON stdout is Loki / ES-compatible).
- [ ] Recovery policy is configured in the manifest's
      `recovery.onRestart`.
- [ ] You've run `@open-rgs/simulator` on each math and the reports
      live with your math lab.
