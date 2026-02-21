# === Build stage: Install dependencies and dumb-init ===
FROM dhi.io/node:25-alpine3.22-dev AS builder

WORKDIR /usr/src/app

# Install dumb-init for process management
RUN apk add --no-cache dumb-init

# Install Dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy App Code
COPY . .
RUN npm run build
RUN npm prune --production && npm cache clean --force

# === Final stage: Create minimal runtime image ===
FROM dhi.io/node:25-alpine3.22

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH

# Copy dumb-init from builder
COPY --from=builder /usr/bin/dumb-init /usr/bin/dumb-init

# Copy application with dependencies from builder
COPY --from=builder --chown=node:node /usr/src/app /app

WORKDIR /app

# Expose Port 4040 (IP Echo Service)
EXPOSE 4040

# Start with dumb-init for proper signal handling
CMD ["dumb-init", "node", "server.js"]
