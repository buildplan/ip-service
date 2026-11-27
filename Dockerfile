# syntax=docker/dockerfile:1

# === Stage 1: Install target-architecture dumb-init ===
FROM dhi.io/node:26.13.1-alpine3.24-dev@sha256:4c2fc73a207122c31ee9dced3a3c4caa79da632058293f7c997bc695ea7db3b8 AS dumb-init
RUN apk add --no-cache dumb-init

# === Stage 2: Install dependencies and build assets natively on host arch ===
FROM --platform=$BUILDPLATFORM dhi.io/node:26.13.1-alpine3.24-dev@sha256:4c2fc73a207122c31ee9dced3a3c4caa79da632058293f7c997bc695ea7db3b8 AS builder

WORKDIR /usr/src/app

# Install Dependencies (cached mount avoids re-downloading tarballs)
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy App Code and build platform-independent assets
COPY . .
RUN npm run build && mv views/app.min.js views/app.js && rm -f views/input.css && npm prune --omit=dev && rm -rf scripts

# === Stage 3: Create minimal runtime image ===
FROM dhi.io/node:26.13.1-alpine3.24@sha256:f7b40a7a5e3b75dafd68687f9f5cd4989a2ca02a5004e03147596e7bf8653acc

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# Copy dumb-init from Stage 1
COPY --from=dumb-init /usr/bin/dumb-init /usr/bin/dumb-init

# Copy application with production dependencies from builder
COPY --from=builder --chown=node:node /usr/src/app /app

WORKDIR /app

# Expose Port 4040 (IP Echo Service)
EXPOSE 4040

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4040/health').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Start with dumb-init for proper signal handling
CMD ["dumb-init", "node", "server.js"]
