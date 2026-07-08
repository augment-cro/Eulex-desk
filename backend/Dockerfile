# ────────────────────────────────────────────────────────────────
#  Max Backend — Cloud Run Dockerfile
#
#  Multi-stage build:
#    1. builder  — install deps + tsc compile
#    2. runner   — slim runtime with LibreOffice for docx→pdf
# ────────────────────────────────────────────────────────────────

# ── Stage 1: Build ──────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# tsc only emits .js — copy data assets (e.g. curated source catalogs)
# from src/ into dist/ at the same relative paths so runtime
# `fs.readFileSync(__dirname, '<file>.json')` calls still resolve.
RUN cd src && find . -name '*.json' -exec sh -c 'mkdir -p "../dist/$(dirname "$1")" && cp "$1" "../dist/$1"' _ {} \;

# ── Stage 2: Runtime ────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

# LibreOffice headless for docx/doc → PDF conversion
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice-writer && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Compiled JS from builder stage
COPY --from=builder /app/dist ./dist

# Built-in MCP connector config (mike/mcp.json). The repo's mike/ folder
# lives outside the backend build context, so cloudbuild.yaml and
# scripts/deploy.sh stage a copy at backend/mike/ before invoking the
# Docker build. The loader (lib/mcp/builtin.ts) checks /app/mike/mcp.json
# as one of its candidate paths.
COPY mike ./mike

# Cloud Run injects PORT env var (default 8080)
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

# Non-root for security. Create a writable home + XDG cache/config dirs so
# headless LibreOffice (soffice) and Fontconfig can write their per-user
# cache. Without this the system user has no writable HOME and DOCX→PDF
# conversion fails with "unable to create directory '/home/mike/.cache/dconf':
# Permission denied" / "Fontconfig error: No writable cache directories".
RUN groupadd -r mike && useradd -r -g mike -m -d /home/mike mike \
    && mkdir -p /home/mike/.cache /home/mike/.config \
    && chown -R mike:mike /home/mike
ENV HOME=/home/mike \
    XDG_CACHE_HOME=/home/mike/.cache \
    XDG_CONFIG_HOME=/home/mike/.config
USER mike

CMD ["node", "dist/index.js"]
