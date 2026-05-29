# Reference Dockerfile for an open-rgs game server.
#
# Inputs (build context is the game repo root):
#   package.json, bun.lock
#   packages/                  (your wallet adapter + vendored open-rgs packages)
#   src/                       (manifest.ts + index.ts wiring)
#   maths/                     (play.lua / play.wasm files)
#
# Outputs:
#   Bun runtime image that runs `bun src/index.ts` on PORT (default 8080),
#   as a NON-root user. Client transport, k8s probes, and (token-gated)
#   admin all share that one port — single-port mode (the createServer
#   default). To isolate admin on a private port, set it in your wiring.
#
# Production runs from source — wasmoon's glue.wasm loads from
# node_modules/ at runtime, no bundling step required.
#
# Base images use exact version tags for reproducibility; for the strongest
# guarantee, pin by digest (oven/bun:1.3.11@sha256:…).

# ---- Install stage ----
FROM oven/bun:1.3.11 AS install
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/ packages/

# Frozen lockfile only — no `|| bun install` fallback, which would silently
# resolve a drifted lockfile and produce a non-reproducible image. A failure
# here means the committed bun.lock is stale; fix it, don't bypass it.
RUN bun install --production --frozen-lockfile

# ---- Runtime stage ----
FROM oven/bun:1.3.11-slim AS runtime
WORKDIR /app

# curl for health checks; everything else is pure-Bun.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Non-privileged port so the process can run as non-root (see USER below).
ENV PORT=8080
# Admin (/admin/* + detailed /healthz) shares this port and FAILS CLOSED in
# production until an admin token is set. Provide one:
#   ENV OPEN_RGS_ADMIN_TOKEN=...   (or inject via your secret manager)

# Server source + dependencies + math files (owned by the non-root bun user).
# Bun runs TypeScript directly — no tsconfig is needed at runtime.
COPY --from=install --chown=bun:bun /app/node_modules/ ./node_modules/
COPY --from=install --chown=bun:bun /app/packages/ ./packages/
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun src/ src/
COPY --chown=bun:bun maths/ maths/

# Drop root — the oven/bun image ships an unprivileged `bun` user (uid 1000).
USER bun

EXPOSE 8080

# In-image liveness check (k8s/compose also probe externally).
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD curl -fs http://localhost:8080/livez || exit 1

CMD ["bun", "src/index.ts"]
