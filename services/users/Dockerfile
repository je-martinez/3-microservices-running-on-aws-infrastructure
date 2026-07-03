# Users service — Fastify + Node 24 (pinned via repo .nvmrc), pnpm via corepack.
# Build context: REPO ROOT (pnpm-lock.yaml and pnpm-workspace.yaml live there).
# Multi-stage: deps stage installs the users package closure; builder stage
# generates the Prisma client and compiles TypeScript (tsc) to dist/; runtime
# stage copies only the compiled output + node_modules and runs plain `node`
# against dist/ (production — no --experimental-strip-types, no dev conditions).
#
# Flow: prisma generate (deps stage, src/generated/prisma/*.ts) → tsc build
# (builder stage, src -> dist, including dist/generated/prisma/*.js) → run
# dist/server.js (runtime stage). generate MUST run before build: the
# generated Prisma client under src/generated is tsc's input.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Prepare the exact pnpm version pinned in the root package.json (packageManager).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps stage: install workspace deps for @3mrai/users + generate Prisma client ──
FROM base AS deps
# Root workspace manifests (lockfile + workspace yaml + root package.json)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Service manifest (needed so pnpm can resolve the filter)
COPY services/users/package.json ./services/users/
# Allow Prisma engine build scripts (needed for prisma generate below)
RUN pnpm install --frozen-lockfile --filter @3mrai/users... --config.ignore-scripts=false
# Prisma schema + migrations are needed to generate the client
COPY services/users/prisma ./services/users/prisma
WORKDIR /app/services/users
# Generate Prisma client into src/generated/prisma (tsc input in the builder stage).
# Invoke the prisma JS entry directly (the pnpm .bin shim contains host-absolute
# paths that break inside the container).
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

# ── builder stage: compile TypeScript (tsc) to dist/ ──────────────────────────
FROM deps AS builder
WORKDIR /app/services/users
# Full service source, including the src/generated/prisma client from deps stage
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
RUN node_modules/.bin/tsc -p tsconfig.json

# ── runtime stage: assemble the final image, run the compiled build ──────────
FROM base AS runtime
# Compiled output only (no src/, no TypeScript toolchain needed at runtime)
COPY --from=builder /app/services/users/dist ./services/users/dist
COPY --from=builder /app/services/users/package.json ./services/users/package.json
# node_modules as installed in deps stage (includes @prisma/client runtime deps)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/users/node_modules ./services/users/node_modules
WORKDIR /app/services/users
EXPOSE 3000
# Plain `node` against the compiled build — no --experimental-strip-types, no
# --conditions=development. The package.json "imports" (#shared/*, #features/*)
# fall back to their "default" condition when no matching condition is active,
# resolving to ./dist/shared/*.js and ./dist/features/*.js (verified: node
# dist/server.js starts and listens without --conditions).
CMD ["node", "dist/server.js"]
