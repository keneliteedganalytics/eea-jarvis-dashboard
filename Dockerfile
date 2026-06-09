# syntax=docker/dockerfile:1.7
# ─── EEA Jarvis Dashboard — production image ──────────────────────────────
# Multi-stage build: install deps + build assets, then ship a slim runtime.

# ── Builder stage ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Pin the Playwright browser cache to a path we copy into the runtime image, so
# the Chromium binary is installed once at build time and persists across deploys
# rather than being re-downloaded on every cold start.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install build deps for better-sqlite3 native module.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install ALL dependencies (incl. dev) for the build step.
COPY package.json package-lock.json ./
RUN npm ci

# Install the Chromium browser + its OS-level shared libraries. `--with-deps`
# apt-installs the fonts/libs headless Chromium needs on Debian; without it the
# browser launch fails at runtime with missing-.so errors. Pinned to chromium
# only (we never launch firefox/webkit) to keep the image small (~280 MB add).
RUN npx playwright install chromium --with-deps

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
    PORT=5000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Headless Chromium needs its OS-level shared libraries (fonts, libnss3, libgbm,
# etc.) present in the runtime image too — the builder's `--with-deps` installed
# them in the builder layer only.
COPY --from=builder /app/node_modules ./node_modules

# Chromium runtime shared libraries. These mirror what
# `playwright install-deps chromium` installs on Debian bookworm, but apt-installed
# directly so we don't depend on the playwright CLI being resolvable at this layer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libdbus-1-3 libxkbcommon0 libatspi2.0-0 libx11-6 libxcomposite1 \
      libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libfontconfig1 fonts-liberation \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# Copy only what production needs.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/shared ./shared

# The Chromium binary cached at build time, so cold starts don't re-download it.
COPY --from=builder /ms-playwright /ms-playwright

# Persistent data volume (Railway mounts here at /data).
# DATABASE_FILE, AUDIO_DIR, UPLOAD_DIR should all point under /data.
RUN mkdir -p /data && chown -R node:node /data

USER node
EXPOSE 5000

# Healthcheck hits our /healthz endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
