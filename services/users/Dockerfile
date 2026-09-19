# Users NestJS service — Node 24 (repo .nvmrc), pnpm via corepack.
# Build context is the REPO ROOT: the lockfile and workspace yaml live there.
#
# CONTRACT: `prisma generate` runs in `deps`, BEFORE the build — the generated
# client under src/generated is tsc's input. See [[users-service-design]]
#
# CONTRACT: Do NOT prune `deps`. `make migrate` reuses that stage directly
# (docker build --target deps) to run `prisma migrate deploy` inside the compose
# network, which needs the prisma CLI and prisma.config.ts from its unpruned
# node_modules. Pruning happens only in `prod-deps`, which `runtime` copies from.

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
# Prisma schema + migrations are needed to generate the client. prisma.config.ts
# is needed too: it supplies datasource.url (DATABASE_WRITER_URL) required by
# `prisma migrate deploy`, which this stage is also reused for (see `make migrate`)
# — `generate` doesn't need it, but copying it here costs nothing and keeps this
# stage usable for both.
COPY services/users/prisma ./services/users/prisma
COPY services/users/prisma.config.ts ./services/users/
WORKDIR /app/services/users
# Generate Prisma client into src/generated/prisma (tsc input in the builder stage).
# Invoke the prisma JS entry directly (the pnpm .bin shim contains host-absolute
# paths that break inside the container).
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

# ── builder stage: compile TypeScript (tsc) to dist/ ──────────────────────────
FROM deps AS builder
WORKDIR /app/services/users
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
# CONTRACT: Regenerate AFTER copying src, not before. src/generated/ is
# gitignored, so the COPY lands whatever the developer's tree holds on top of
# deps' client — a stale one type-checks against an older schema and fails the
# build naming columns the schema DOES have. Fresh clones never see it.
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

# ── builder stage: compile TypeScript (tsc) to dist/ ──────────────────────────
FROM deps AS builder
WORKDIR /app/services/users
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
# CONTRACT: Regenerate AFTER copying src. src/generated/ is gitignored, so the
# COPY lands whatever the developer's tree holds on top of deps' client, and a
# stale one fails the build naming columns the schema DOES have.
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

# ── builder stage: compile TypeScript (tsc) to dist/ ──────────────────────────
FROM deps AS builder
WORKDIR /app/services/users
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
# CONTRACT: Regenerate AFTER copying src, not before. src/generated/ is
# gitignored, so the COPY lands whatever the developer's tree holds on top of
# deps' client — a stale one type-checks against an older schema and fails the
# build naming columns the schema DOES have. Fresh clones never see it.
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma

# ── builder stage: compile TypeScript (tsc) to dist/ ──────────────────────────
FROM deps AS builder
WORKDIR /app/services/users
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
# CONTRACT: Regenerate AFTER copying src. src/generated/ is gitignored, so the
# COPY lands whatever the developer's tree holds on top of deps' client, and a
# stale one fails the build naming columns the schema DOES have.
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma
RUN node_modules/.bin/tsc -p tsconfig.json

# ── prod-deps stage: prune devDependencies (prisma CLI, typescript, @types/*, tsx, vitest, eslint) ──
FROM deps AS prod-deps
# CONTRACT: `pnpm deploy`, NOT `pnpm prune`. On a filter-installed workspace
# subset, `prune` prompts to reinstall node_modules from scratch and — with no
# TTY to confirm — silently no-ops, shipping devDependencies to production.
# `deploy` clones from the local content store, so it needs no network.
RUN pnpm --filter @3mrai/users deploy --prod --config.ignore-scripts=false /tmp/deploy

# ── runtime stage: assemble the final image, run the compiled build ──────────
FROM base AS runtime
# Compiled output only (no src/, no TypeScript toolchain needed at runtime)
COPY --from=builder /app/services/users/dist ./services/users/dist
COPY --from=builder /app/services/users/package.json ./services/users/package.json
# Pruned node_modules (prod-deps stage, via `pnpm deploy`) — devDependencies
# (prisma CLI, typescript, tsx, vitest, eslint, @types/*) excluded;
# @prisma/client's runtime deps kept. `pnpm deploy` produces a flat,
# self-contained node_modules (no separate root + subpackage split), so this
# is the only node_modules copy runtime needs.
COPY --from=prod-deps /tmp/deploy/node_modules ./node_modules
# Shared gRPC contract: the gRPC server loads proto/users.proto at runtime via a
# path resolved five levels up from its own dir → /app/proto/users.proto. It is
# NOT part of dist/, so copy it explicitly, else the container crashes at boot
# with ENOENT '/app/proto/users.proto'.
COPY proto/users.proto /app/proto/users.proto
WORKDIR /app/services/users
EXPOSE 3000
# Plain `node` against the compiled build: the package.json "imports" fall back
# to their "default" condition, resolving to ./dist/**.
#
# CONTRACT: --import loads the OTel bootstrap in its OWN module graph. This is
# ESM, where static imports are hoisted before any module body runs, so
# importing the SDK "first" inside main.ts still leaves @grpc/grpc-js loaded
# before sdk.start() patches it and the gRPC server comes out uninstrumented.
# See [[ADR-0019-distributed-tracing-opentelemetry]]
CMD ["node", "--import", "./dist/shared/observability/tracing.js", "dist/main.js"]
