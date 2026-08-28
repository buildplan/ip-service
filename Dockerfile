# === Build stage: Install dependencies and dumb-init ===
FROM dhi.io/node:26.8.1-alpine3.24-dev@sha256:607822ecb03181c53b0981abcbc930e609299ceba1ca4e47035ae67384b14fca AS builder

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
FROM dhi.io/node:26.8.1-alpine3.24@sha256:282cb9422b3c54012479cf4642d5aee93c1123d1ef3339744c13b11bec27f6d5

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
