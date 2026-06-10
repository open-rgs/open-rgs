# Spec 07  - Deployment

## Goal

Define how a deployer goes from "I have a set of math files and a
platform adapter" to "I have a running production RGS server." The
server image is the same MIT bits everywhere; deployments differ by
which maths and which wallet are baked in.

## Deployment unit

A deployable game server is:

```
  @open-rgs/core         (MIT, npm)
  @open-rgs/contract     (MIT, npm)
  @open-rgs/transport-binary  (MIT, npm  - currently inside core)
  + 1 platform adapter           (per operator, usually private)
  + N math files               (per game, paths in manifest)
  + 1 manifest.ts              (composes maths into modes)
  + 1 src/index.ts             (35-line wiring)
  + Dockerfile / deployment infra
```

Everything else (RNG sidecar, metrics scraping, log shipping) is
optional infrastructure each operator wires per their stack.

## Math bundling pattern

Math files live in a `maths/` directory at the repo root, one folder
per math. Each folder contains either:

- `play.lua` (or `play.wasm`, or `play.ts`)  - the math source/artifact.
- `README.md`  - design notes, RTP target, certification status.
- Optional: `parameters.json`  - declared knobs for the optimizer.
- Optional: `certification/`  - measured-RTP reports, math-lab
  signatures, build recipes.

The manifest references each file by relative path:

```ts
modes: {
  "default":    { math: "./maths/base/play.lua",       stakeMultiplier: 1 },
  "buy-fs":     { math: "./maths/buy-fs/play.lua",     stakeMultiplier: 80 },
  "free-spins": { math: "./maths/free-spins/play.lua", stakeMultiplier: 0,
                  internal: true },
}
```

Same math file can be referenced from multiple manifests in the same
repo (different RTP variants of the same game) or shipped as a private
npm package consumed by multiple game repos.

## Required environment variables

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `PORT` | no | `80` | Client transport WS port |
| `ADMIN_PORT` | no | `81` | Admin/health HTTP port |
| `NODE_ENV` | no | `development` | `production` strips dev-only paths |
| `LOG_LEVEL` | no | env-derived | Override min log level |
| `GAME_ID` | yes (or in code) |  - | Game identifier  - used by adapters |
| `API_KEY` | per adapter |  - | Platform adapter auth |
| `PLATFORM_WS_URL` | per adapter |  - | Wallet endpoint |
| `RNG_URL` | no | none | When set, math.random routes via certified RNG sidecar |
| `RANDOM_WORKER_COMMAND` | no | none | Command to start the RNG sidecar |

Wallet adapters declare any additional env vars they consume in their
own README. The orchestrator reads none of them itself.

## Reference Dockerfile

Two-stage build, bun-runtime base. Production runs `bun src/index.ts`
directly  - no bundling step (wasmoon's `glue.wasm` loads from
`node_modules/`).

```dockerfile
# ---- Install stage ----
FROM oven/bun:1 AS install
WORKDIR /app
COPY package.json bun.lock* ./
COPY packages/ packages/
RUN bun install --production --frozen-lockfile

# ---- Runtime stage ----
FROM oven/bun:1-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=80
ENV ADMIN_PORT=81

COPY --from=install /app/node_modules/ ./node_modules/
COPY --from=install /app/packages/ ./packages/
COPY package.json tsconfig.json tsconfig.base.json ./
COPY src/ src/
COPY maths/ maths/

EXPOSE 80 81
CMD ["bun", "src/index.ts"]
```

If the deployment uses a certified RNG sidecar, add a build stage for
the sidecar binary and an `entrypoint.sh` that starts it before the
server (the example-game-server reference deployment does this with a .NET
self-contained binary; see its repo for the full pattern).

## K8s deployment shape

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: <game-id> }
spec:
  replicas: 3                        # stateless  - scale freely
  template:
    spec:
      securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
      containers:
      - name: rgs
        image: <registry>/<game-id>:<sha>
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }
        ports:
          - { name: ws, containerPort: 8080 }   # WS + probes + admin (single-port, non-privileged)
        env:
          - { name: PORT, value: "8080" }
          - { name: OPEN_RGS_ADMIN_TOKEN, valueFrom: { secretKeyRef: { ... } } }  # admin fails closed without it
          - { name: API_KEY, valueFrom: { secretKeyRef: { ... } } }
          - { name: PLATFORM_WS_URL, value: ws://platform.example.com/v1/ws }
        readinessProbe:
          httpGet: { path: /readyz, port: ws }
          periodSeconds: 5
        livenessProbe:
          httpGet: { path: /livez, port: ws }
          periodSeconds: 10
        resources:
          requests: { cpu: 100m, memory: 128Mi }
          limits:   { cpu: 1000m, memory: 256Mi }
---
apiVersion: v1
kind: Service
metadata: { name: <game-id> }
spec:
  selector: { app: <game-id> }
  ports:
    - { name: ws, port: 80, targetPort: ws }
```

Notes:
- `livenessProbe` MUST hit `/livez` (always 200 if process is up)  - NOT
  `/healthz`, which goes 503 when the wallet is unhealthy. We don't
  want the wallet flapping to restart pods.
- `readinessProbe` SHOULD hit `/readyz` (200 healthy / 503 when the wallet
  is down) so K8s pulls a pod out of rotation when the wallet is down.
  Use `/readyz`, not `/healthz`: probes are unauthenticated, while the
  detailed `/healthz` requires the admin token (see Admin auth below) and
  would 403 the probe.
- **Ingress prefix (`adminRouteBasePath`).** If a public ingress mounts
  admin under a prefix (e.g. `/api/<game-id>/*`) and forwards *without*
  rewriting it, set `adminRouteBasePath: "/api/<game-id>"` in
  `createServer`. Each canonical route then matches in BOTH the
  prefixed (`/api/<game-id>/livez`) and the bare (`/livez`) shape  - so
  the public ingress sees the prefixed form while k8s probes and the
  Docker HEALTHCHECK keep hitting the pod IP at the bare paths shown
  above. Matching stays EXACT (`===`) for both shapes; no suffix
  collisions.
- **Admin auth.** `/admin/*` and the detailed `/healthz` require
  `Authorization: Bearer <token>`; set it via `adminToken` /
  `OPEN_RGS_ADMIN_TOKEN`. In production these routes fail closed (403)
  without a token. In single-port mode admin shares the public client
  port, so either set a token or run admin on a separate `adminPort` bound
  to a private interface behind a default-deny NetworkPolicy. CORS is never
  wildcard  - set `adminAllowedOrigins` for a browser dashboard.
- **Public `/healthz` (opt-in).** Set `adminPublicHealthz: true` (or
  `publicHealthz: true` directly on an `AdminConfig`) when a dashboard
  or external uptime prober needs to read `/healthz` from somewhere
  that can't inject a token. Same JSON shape, no auth  - exposes
  core/game/math versions, uptime, session COUNT, and platform
  connection state. `/admin/*` stays gated. For probe-level
  "is it up?" checks prefer `/readyz` (always open, 503 when the
  platform is down). Default false.
- No persistent volume  - the orchestrator owns no durable state.
- Sticky sessions are nice-to-have (faster reconnect -> in-memory
  session cache hit) but NOT required for correctness.

### Instance identity & metrics scraping

Every server resolves a unique **instance id** at boot: explicit
`createServer({ instanceId })` > `OPEN_RGS_INSTANCE_ID` env > a
self-generated `rgs-<8 hex>`. In K8s, pass the pod name via the downward
API so the id matches `kubectl` output:

```yaml
env:
  - name: OPEN_RGS_INSTANCE_ID
    valueFrom: { fieldRef: { fieldPath: metadata.name } }
```

The id is surfaced in three places that correlate one-to-one:
`rgs_build_info{instance_id,...}` on `/admin/metrics` (the node_exporter
build_info pattern  - a fresh series appearing = an instance (re)started),
`instance_id` in `/healthz`, and `service.instance.id` on every log line.

`/admin/metrics` serves Prometheus exposition behind the admin bearer
token (`authorization.credentials` in the scrape config). Metrics are
pod-local  - scrape every pod and aggregate in dashboards. Alongside the
round/math/session series, the platform-adapter SLA series answer "is the
wallet there, and is it answering":

| Series | Meaning |
|---|---|
| `rgs_platform_connected` | 1 while the adapter reports healthy |
| `rgs_platform_connection_transitions_total{direction}` | flap counter |
| `rgs_platform_last_ok_timestamp_seconds` | last SUCCESSFUL RPC; alert on `time() - x > 30` to catch a connected-but-silent wallet |
| `rgs_platform_call_duration_seconds{method}` | RPC latency histogram |
| `rgs_platform_call_errors_total{method,reason}` | errors, reason includes `timeout` / `disconnected` |

Financial series are in-process monotonic counters in the currency's minor
unit; the server only increments, and GGR / RTP are DERIVED at query time
(ratios don't aggregate across a fleet - counters do):

| Series | Meaning |
|---|---|
| `rgs_bets_minor_total{currency,mode,funding}` | stakes; `funding=real` = actual debit (effective cost), `funding=promo` = notional free-round bet |
| `rgs_wins_minor_total{currency,mode,funding}` | wins credited, by the round's funding |
| `rgs_declared_rtp{mode}` | the theoretical target line |

```promql
# GGR per currency (house view: real stakes minus all wins paid)
sum by (currency) (rgs_bets_minor_total{funding="real"})
  - sum by (currency) (rgs_wins_minor_total)

# Live RTP over a window, vs the declared line
sum(increase(rgs_wins_minor_total[1h]))
  / sum(increase(rgs_bets_minor_total[1h]))
```

Each instance also logs a `financial_snapshot` line on an interval
(`financialLogIntervalMs`, default 10 min, 0 = off): lifetime per-currency
bets/wins/GGR/RTP read straight from the in-memory counters - the money
picture survives in plain logs even with no metrics stack attached.

## Platform adapter packaging

Three patterns:

1. **In the same repo as the game** (e.g., `example-game-server` has
   `packages/my-wallet-adapter/`). Simplest. Platform adapter is private to
   the game's deployment.
2. **Private npm package** (`@operator/wallet-adapter`). Multiple games
   pull the same adapter. Versioned independently.
3. **Open-source npm package** (`@open-rgs/wallet-<operator>`).
   For wallets the operator is willing to publish. None exist today.

## Math packaging

Two patterns:

1. **In-tree** (the default): math files live in `maths/` of the game
   repo. Referenced by relative path. Co-versioned with the manifest.
2. **As a private npm package** (`@studio/math-base-91`). Same math
   shipped to multiple game variants. Manifest imports the package and
   reads `pkg.entryPath` to find the `.lua` / `.wasm` file.

For MIT-published example games (`lucky-digits`, `gamble-cherry`),
math is in-tree.

## Multi-game deployments

`createServer` accepts **one manifest per process**  - one game per
process. This is deliberate, not a missing feature: in-process
multi-tenancy isn't worth its complexity (spec 10, "What we deliberately
AVOID"; spec 02, "Open questions").

To run several games, run several single-game processes  - on separate
ports, or as separate images  - and route to them at the edge (an ingress
or reverse proxy mapping a path or host per game):

```ts
// one process per game, each its own createServer:
await createServer({ manifest: luckyDigits, platform, transport: binaryTransport({ port: 8081 }) });
await createServer({ manifest: gambleCherry, platform, transport: binaryTransport({ port: 8082 }) });
// edge routes /lucky-digits/* -> :8081, /gamble-cherry/* -> :8082
```

## Acceptance criteria

- The reference Dockerfile in `deploy/docker/` builds a runnable image
  on `oven/bun:1` base.
- The image starts and serves `/livez` within 5 seconds of container
  start, given wallet env vars.
- The image starts and serves the WS transport correctly even when
  the wallet endpoint is unreachable (returns `PLATFORM_UNAVAILABLE`
  on INIT).
- A K8s Deployment with `replicas: 3` round-robins INITs across pods
  with no shared state required.
- `kubectl rollout restart` (no other config) survives in-flight
  simple rounds (they complete on the same pod) and produces
  short-lived disruption only for complex rounds in flight (autoclose
  policy applies).

## Open questions

- Should the Dockerfile bundle a Zig toolchain for in-image math
  rebuilds? **No**  - artifacts ship pre-built; the runtime image stays
  thin.
- Should we publish a Helm chart? **Probably eventually**; Spec 09
  tracks it.
- Should the deploy template include a Prometheus ServiceMonitor?
  **Resolved: plain scrape config instead.** The observability pack
  (`deploy/observability/` - scrape config, alert rules, Grafana
  dashboard) uses a raw `kubernetes_sd_configs` job, which works on
  any Prometheus; prometheus-operator users can transcribe it into a
  ServiceMonitor/PodMonitor trivially.
