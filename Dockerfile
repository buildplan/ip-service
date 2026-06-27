# === Build stage: Install dependencies and dumb-init ===
FROM dhi.io/node:26.4.0-alpine3.24-dev@sha256:f2c78040749b3ff6cae023afd0744ea153d35b60d865dd50ff73b748cca174d4 AS builder

WORKDIR /usr/src/app

# Install dumb-init for process management
RUN apk add --no-cache dumb-init

# Install Dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy App Code
COPY . .
RUN npm run build
RUN mv views/app.min.js views/app.js && rm views/input.css
RUN npm prune --production && npm cache clean --force

# === Final stage: Create minimal runtime image ===
FROM dhi.io/node:26.4.0-alpine3.24@sha256:fedb4f426b8fcc707e5186f886ff6bfe2f589fc4eaf6da5b4632e51beb3a4b8f

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# Copy dumb-init from builder
COPY --from=builder /usr/bin/dumb-init /usr/bin/dumb-init

# Copy application with dependencies from builder
COPY --from=builder --chown=node:node /usr/src/app /app

WORKDIR /app

# Expose Port 4040 (IP Echo Service)
EXPOSE 4040

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:4040/health').then(res => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Start with dumb-init for proper signal handling
CMD ["dumb-init", "node", "server.js"]
