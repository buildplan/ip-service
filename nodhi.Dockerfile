# syntax=docker/dockerfile:1

# === STAGE 1: TARGET-ARCH DUMB-INIT ===
FROM node:26-alpine3.24 AS dumb-init
RUN apk add --no-cache dumb-init

# === STAGE 2: BUILDER (HOST ARCH) ===
FROM --platform=$BUILDPLATFORM node:26-alpine3.24 AS builder

WORKDIR /usr/src/app

# Install Dependencies
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci

# Copy App Code & Build Assets
COPY . .
RUN npm run build && mv views/app.min.js views/app.js && rm -f views/input.css && npm prune --omit=dev && rm -rf scripts

# === STAGE 3: RUNTIME ===
FROM node:26-alpine3.24

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# Copy dumb-init from Stage 1
COPY --from=dumb-init /usr/bin/dumb-init /usr/bin/dumb-init

# Copy application with dependencies from builder
COPY --from=builder --chown=node:node /usr/src/app /app

WORKDIR /app

# Switch to the secure non-root user
USER node

# Expose Port 4040 (IP Echo Service)
EXPOSE 4040

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4040/health').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["dumb-init", "node", "server.js"]
