# 1. Use the latest LTS version
FROM node:24-alpine

# 2. INSTALL DUMB-INIT
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# 3. OPTIMIZE PERMISSIONS & SECURITY
RUN chown -R node:node /app

# Switch to non-root user
USER node

# 4. CACHING LAYER
COPY --chown=node:node package.json package-lock.json* ./
RUN npm ci --only=production && npm cache clean --force

# 5. Create the db directoy
RUN mkdir -p /app/db

# 6. APP LAYER
#    (Ensure .dockerignore excludes node_modules and big DB files!)
COPY --chown=node:node . .

EXPOSE 4040

# 7. USE DUMB-INIT
CMD ["dumb-init", "node", "server.js"]
