# ===========================================================================
# Helio MCP Governance Proxy — Docker Image
#
# Multi-stage build:
#   1. deps      - install all dependencies (including native build tools)
#   2. build     - compile TypeScript (dashboard + proxy)
#   3. prod-deps - install the proxy's production dependencies alone, fresh
#   4. runtime   - slim image with built artifacts + prod deps
#
# Usage:
#   docker build -f docker/Dockerfile .          (from repo root)
#   docker run -v ./helio.yaml:/config/helio.yaml -p 3000:3000 -p 3100:3100 helio
# ===========================================================================

# ===========================================================================
# Stage 1: Install all dependencies
# ===========================================================================
FROM node:24-slim AS deps

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

# Install native build tools for better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile + workspace config first (layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/proxy/package.json packages/proxy/
COPY packages/dashboard/package.json packages/dashboard/

# Install all dependencies (dev included — needed for build)
RUN pnpm install --frozen-lockfile

# ===========================================================================
# Stage 2: Build proxy (bundles dashboard assets)
# ===========================================================================
FROM deps AS build

# Copy TypeScript configs
COPY tsconfig.base.json tsconfig.json ./

# Copy source (dashboard first — proxy depends on it)
COPY packages/dashboard/ packages/dashboard/
COPY packages/proxy/ packages/proxy/

# Build proxy package (its build script compiles dashboard and bundles assets)
RUN pnpm --filter @gethelio/proxy build

# ===========================================================================
# Stage 3: Production dependencies only
# ===========================================================================
FROM deps AS prod-deps

# Start from an empty modules tree. A production install over the tree
# inherited from deps unlinks the dev packages but leaves their
# directories under node_modules/.pnpm, and the runtime stage copies the
# directory whole.
RUN rm -rf node_modules packages/proxy/node_modules packages/dashboard/node_modules

# Install the proxy's production tree alone, from the store the deps stage
# filled (nothing is downloaded). --filter keeps the dashboard's tree out:
# the dashboard reaches the image only as the bundle the build stage writes
# under packages/proxy/dist/dashboard-assets. --ignore-scripts keeps pnpm 11
# from running the root prepare script (husky, a dev dependency that is not
# installed here). The result is the tree the release sbom.json inventories
# (scripts/generate-sbom.sh); scripts/check-image-inventory.sh asserts it
# in CI.
RUN CI=true pnpm install --frozen-lockfile --prod --ignore-scripts --filter @gethelio/proxy

# The one build script the tree needs. better-sqlite3's install script takes
# the prebuilt binary the deps stage already fetched for this platform, or
# compiles one with the build tools installed there.
RUN CI=true pnpm --filter @gethelio/proxy rebuild better-sqlite3

# ===========================================================================
# Stage 4: Slim runtime image
# ===========================================================================
FROM node:24-slim AS runtime

# Enable corepack for pnpm workspace resolution
RUN corepack enable && corepack prepare pnpm@11.13.0 --activate

# Install tini for proper PID 1 signal handling
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy production node_modules from prod-deps stage
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/proxy/node_modules ./packages/proxy/node_modules

# Copy workspace config (needed for pnpm workspace resolution at runtime)
COPY package.json pnpm-workspace.yaml ./
COPY packages/proxy/package.json packages/proxy/

# Copy built artifacts
COPY --from=build /app/packages/proxy/dist ./packages/proxy/dist

# Create volume mount points for config and data
RUN mkdir -p /data /config

# Run as non-root user
RUN chown -R node:node /app /data /config
USER node

# Volumes for config file and SQLite audit database
VOLUME ["/config", "/data"]

# Expose proxy + dashboard ports
EXPOSE 3000 3100

# Health check — lets Docker/orchestrators detect unresponsive proxy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

# Use tini as init process (forwards SIGTERM for graceful shutdown)
ENTRYPOINT ["tini", "--"]

# Start the proxy — config path from /config/helio.yaml
CMD ["node", "packages/proxy/dist/cli.js", "start", "-c", "/config/helio.yaml"]
