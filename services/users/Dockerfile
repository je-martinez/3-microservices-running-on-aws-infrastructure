# Users service — Fastify + Node 24 (pinned via repo .nvmrc), pnpm via corepack.
# Build context: REPO ROOT (pnpm-lock.yaml and pnpm-workspace.yaml live there).
# Multi-stage: deps stage installs only the users package closure;
# runtime stage copies the result and runs the server with --experimental-strip-types.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Prepare the exact pnpm version pinned in the root package.json (packageManager).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps stage: install workspace deps for @3mrai/users ──────────────────────
FROM base AS deps
# Root workspace manifests (lockfile + workspace yaml + root package.json)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Service manifest (needed so pnpm can resolve the filter)
COPY services/users/package.json ./services/users/
# Allow Prisma engine build scripts (needed for prisma generate later)
RUN pnpm install --frozen-lockfile --filter @3mrai/users... --config.ignore-scripts=false

# ── runtime stage: assemble the final image ───────────────────────────────────
FROM base AS runtime
# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/users/node_modules ./services/users/node_modules
# Copy full service source (prisma schema + src)
COPY services/users ./services/users
WORKDIR /app/services/users
# Generate Prisma client. Invoke the prisma JS entry directly (the pnpm .bin
# shim contains host-absolute paths that break inside the container).
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma
EXPOSE 3000
# Uses Node's native TypeScript strip-types (no separate tsc build step needed).
# The compose develop:watch syncs ./services/users/src → /app/services/users/src
# so live edits are reflected without a rebuild.
CMD ["node", "--experimental-strip-types", "src/server.ts"]
