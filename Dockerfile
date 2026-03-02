# ── Build stage ──────────────────────────────────────────────────────────────
# Install only production dependencies in a clean layer so the final image
# does not carry the npm cache or dev tooling.
FROM node:20-alpine AS deps

WORKDIR /app

# Copy lockfile and manifest first for better layer-cache reuse.
# A change to source files won't re-run npm ci unless dependencies changed.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Runtime image ─────────────────────────────────────────────────────────────
FROM node:20-alpine

# Run as a non-root user (least-privilege).
RUN addgroup -g 1001 -S nodejs && adduser -S nodeapp -u 1001

WORKDIR /app

# Copy installed modules from the deps stage.
COPY --from=deps --chown=nodeapp:nodejs /app/node_modules ./node_modules

# Copy application source (everything not excluded by .dockerignore).
COPY --chown=nodeapp:nodejs . .

USER nodeapp

# The app listens on $PORT (defaults to 3000 in server.js).
# Coolify injects PORT automatically; Traefik routes to this port.
EXPOSE 3000

# Use Node.js for the healthcheck — it is always present in the image,
# unlike wget/curl which are not guaranteed in node:alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Use the plain "node server.js" entrypoint – no TURN server needed in
# production (P2P is restricted to the local network via ICE filtering).
CMD ["node", "server.js"]
