# syntax=docker/dockerfile:1.7
# ─── EEA Jarvis Dashboard — production image ──────────────────────────────
# Multi-stage build: install deps + build assets, then ship a slim runtime.

# ── Builder stage ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install build deps for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies (incl. dev) for the build step.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build.
COPY . .
RUN npm run build

# Prune to production-only dependencies for the runtime image.
RUN npm prune --omit=dev

# ── Runtime stage ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# better-sqlite3 needs libc / libstdc++ at runtime (already in slim image)
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5000

# Copy only what production needs.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/shared ./shared

# Persistent data volume (Railway mounts here at /data).
# DATABASE_FILE, AUDIO_DIR, UPLOAD_DIR should all point under /data.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 5000

# Healthcheck hits our /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
