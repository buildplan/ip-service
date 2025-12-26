# Use Node 24 LTS
FROM node:24-slim

# 1. OS SETUP (Run as Root)
RUN apt-get update && apt-get install -y --no-install-recommends \
    whois \
    netbase \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# 2. PERMISSIONS SETUP
WORKDIR /app
RUN chown node:node /app

# 3. SWITCH USER
USER node

# 4. DEPENDENCIES
COPY --chown=node:node package*.json ./

# npm ci
RUN npm ci --omit=dev && npm cache clean --force

# 5. APP CODE
COPY --chown=node:node . .

# 6. RUNTIME
EXPOSE 3000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]