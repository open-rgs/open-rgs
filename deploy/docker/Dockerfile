# Reference Dockerfile for an open-rgs game server.
#
# Inputs (build context is the game repo root):
#   package.json, bun.lock
#   packages/                  (your wallet adapter + vendored open-rgs packages)
#   src/                       (manifest.ts + index.ts wiring)
#   maths/                     (play.lua / play.wasm files)
#
# Outputs:
#   Bun runtime image that runs `bun src/index.ts` on PORT (default 80).
#
# Production runs from source — wasmoon's glue.wasm loads from
# node_modules/ at runtime, no bundling step required.

# ---- Install stage ----
FROM oven/bun:1 AS install
WORKDIR /app

COPY package.json bun.lock* ./
COPY packages/ packages/

RUN bun install --production --frozen-lockfile || bun install --production

# ---- Runtime stage ----
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# curl for health checks; everything else is pure-Bun.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=80
ENV ADMIN_PORT=81

# Server source + dependencies + math files
COPY --from=install /app/node_modules/ ./node_modules/
COPY --from=install /app/packages/ ./packages/
COPY package.json tsconfig.json tsconfig.base.json ./
COPY src/ src/
COPY maths/ maths/

EXPOSE 80 81

# Liveness/readiness handled externally via /livez and /healthz on ADMIN_PORT.
CMD ["bun", "src/index.ts"]
