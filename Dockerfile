# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# mc-next-mcp-server
#
# stdio-only MCP server. The container communicates over stdin/stdout, so it
# MUST be run with an attached stdin (`docker run -i`). It exposes no port.
#
# Layout note: src/catalog.ts resolves the catalog as `dist/../catalog`, so
# `dist/` and `catalog/` must remain siblings in the final image.
#
# Base image: node:24-alpine is the active LTS. Node 18 (the version originally
# suggested) reached end-of-life on 2025-03-27, and Node 20 on 2026-03-24, so
# neither receives security patches. The package still *runs* on Node >= 18
# (see `engines`), but shipping an EOL runtime in an image is not advisable.
# ---------------------------------------------------------------------------

ARG NODE_VERSION=24-alpine

# --- Build stage: compile TypeScript ---------------------------------------
FROM node:${NODE_VERSION} AS build

WORKDIR /app

# Install all deps (including devDependencies) using the lockfile for
# reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile. The catalog is committed, so `npm run generate` is not needed here
# (the source Postman collections are not in the repo, and `generate` would
# correctly refuse to run without them).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# --- Runtime stage ----------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

# Run as the non-root `node` user that the official image provides.
USER node

WORKDIR /app

# Production dependencies only.
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# Compiled output and the generated catalog. These must stay siblings so that
# `dist/../catalog/endpoints.json` resolves.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node package.json ./

# --- Configuration defaults -------------------------------------------------
# These mirror the documented defaults in src/config.ts. They are set so the
# image is self-describing and `docker inspect` shows the effective config.
#
# Credentials are deliberately NOT set here — passing them at build time would
# bake them into the image layer. Supply them at run time via --env-file.
ENV NODE_ENV=production \
    SF_LOGIN_URL=https://login.salesforce.com \
    SF_API_VERSION=66.0 \
    MC_NEXT_TIMEOUT_MS=60000 \
    MC_NEXT_MAX_RETRIES=3 \
    MC_NEXT_ALLOW_DESTRUCTIVE=false \
    MC_NEXT_ALLOW_METADATA_CHANGES=false \
    MC_NEXT_DEBUG=false

# Diagnostics only — never required for the server to run. Confirms the catalog
# is present and parseable.
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const c=require('/app/catalog/endpoints.json');process.exit(c.endpoints.length>0?0:1)"

# The entrypoint is the MCP server. It speaks JSON-RPC over stdio.
ENTRYPOINT ["node", "dist/index.js"]
