# STAGE 1: BUILDER
FROM node:24-slim AS builder

WORKDIR /app

# Install system build dependencies 
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

# Copy App Code and Run Build
COPY . .
RUN npm run build

# Prune node_modules to only keep production dependencies
RUN npm prune --production && npm cache clean --force


# STAGE 2: RUNTIME
FROM node:24-slim

# OS SETUP (Runtime dependencies)
RUN apt-get update && apt-get install -y --no-install-recommends \
    whois \
    netbase \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# PERMISSIONS SETUP
WORKDIR /app
RUN chown node:node /app

# COPY ONLY PRODUCTION ASSETS
USER node

# Copy production node_modules
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application source
COPY --from=builder --chown=node:node /app ./

# 3. FINAL CLEANUP
RUN rm -f views/input.css views/app.min.js

EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
