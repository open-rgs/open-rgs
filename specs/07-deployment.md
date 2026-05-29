# Spec 07 — Deployment

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
  @open-rgs/transport-binary  (MIT, npm — currently inside core)
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

- `play.lua` (or `play.wasm`, or `play.ts`) — the math source/artifact.
- `README.md` — design notes, RTP target, certification status.
- Optional: `parameters.json` — declared knobs for the optimizer.
- Optional: `certification/` — measured-RTP reports, math-lab
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
| `GAME_ID` | yes (or in code) | — | Game identifier — used by adapters |
| `API_KEY` | per adapter | — | Platform adapter auth |
| `PLATFORM_WS_URL` | per adapter | — | Wallet endpoint |
| `RNG_URL` | no | none | When set, math.random routes via certified RNG sidecar |
| `RANDOM_WORKER_COMMAND` | no | none | Command to start the RNG sidecar |

Wallet adapters declare any additional env vars they consume in their
own README. The orchestrator reads none of them itself.

## Reference Dockerfile

Two-stage build, bun-runtime base. Production runs `bun src/index.ts`
directly — no bundling step (wasmoon's `glue.wasm` loads from
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
  replicas: 3                        # stateless — scale freely
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
- `livenessProbe` MUST hit `/livez` (always 200 if process is up) — NOT
  `/healthz`, which goes 503 when the wallet is unhealthy. We don't
  want the wallet flapping to restart pods.
- `readinessProbe` SHOULD hit `/readyz` (200 healthy / 503 when the wallet
  is down) so K8s pulls a pod out of rotation when the wallet is down.
  Use `/readyz`, not `/healthz`: probes are unauthenticated, while the
  detailed `/healthz` requires the admin token (see Admin auth below) and
  would 403 the probe.
- **Admin auth.** `/admin/*` and the detailed `/healthz` require
  `Authorization: Bearer <token>`; set it via `adminToken` /
  `OPEN_RGS_ADMIN_TOKEN`. In production these routes fail closed (403)
  without a token. In single-port mode admin shares the public client
  port, so either set a token or run admin on a separate `adminPort` bound
  to a private interface behind a default-deny NetworkPolicy. CORS is never
  wildcard — set `adminAllowedOrigins` for a browser dashboard. Routing is
  exact; if your ingress serves admin under a prefix, declare it via
  `adminRouteBasePath`.
- No persistent volume — the orchestrator owns no durable state.
- Sticky sessions are nice-to-have (faster reconnect → in-memory
  session cache hit) but NOT required for correctness.

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

Currently `createServer` accepts one manifest per process. To run two
games, run two processes on two ports, or build two images.

Multi-game-per-process support is on the roadmap (see **Spec 09**).
When it lands, deployment looks like:

```ts
await createServer({
  manifests: [luckyDigits, gambleCherry],
  wallet: new MyAdapter({ ... }),
  transport: binaryTransport({ port: 80 }),
});
// → /api/lucky-digits/wss   and   /api/gamble-cherry/wss
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
  rebuilds? **No** — artifacts ship pre-built; the runtime image stays
  thin.
- Should we publish a Helm chart? **Probably eventually**; Spec 09
  tracks it.
- Should the deploy template include a Prometheus ServiceMonitor?
  Once `/metrics` exists. **Pending Spec 06 follow-up.**
