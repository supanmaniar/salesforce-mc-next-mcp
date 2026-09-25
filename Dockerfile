# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# mc-next-mcp-server
#
# stdio-only MCP server. The container communicates over stdin/stdout, so it
# MUST be run with an attached stdin (`docker run -i`). It exposes no port.
#
# Layout note: src/catalog.ts resolves the catalog as `dist/../catalog`, so
# `dist/` and `catalog/` must remain siblings in the final image.
# ---------------------------------------------------------------------------

# --- Build stage: compile TypeScript ---------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install all deps (including devDependencies) using the lockfile for
# reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile. The catalog is committed, so `npm run generate` is not needed here
# (the source Postman collections are not in the repo).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies from the tree we are about to copy forward.
RUN npm prune --omit=dev

# --- Runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

# Run as a non-root user.
USER node

WORKDIR /app

# Production dependencies only.
COPY --from=build --chown=node:node /app/node_modules ./node_modules

# Compiled output and the generated catalog. These must stay siblings so that
# `dist/../catalog/endpoints.json` resolves.
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node catalog ./catalog
COPY --chown=node:node package.json ./

# Diagnostics only — never required for the server to run.
HEALTHCHECK --interval=60s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "const c=require('/app/catalog/endpoints.json');process.exit(c.endpoints.length>0?0:1)"

# The entrypoint is the MCP server. It speaks JSON-RPC over stdio.
ENTRYPOINT ["node", "dist/index.js"]
