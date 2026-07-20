# Users service — Fastify + Node 24 (pinned via repo .nvmrc), pnpm via corepack.
# Build context: REPO ROOT (pnpm-lock.yaml and pnpm-workspace.yaml live there).
# Multi-stage: deps stage installs the users package closure (full, including
# devDependencies — reused as-is by `make migrate`, see below); builder stage
# generates the Prisma client and compiles TypeScript (tsc) to dist/; prod-deps
# stage prunes devDependencies out of a copy of deps' node_modules; runtime
# stage copies only the compiled output + the PRUNED node_modules and runs
# plain `node` against dist/ (production — no --experimental-strip-types, no
# dev conditions).
#
# Flow: prisma generate (deps stage, src/generated/prisma/*.ts) → tsc build
# (builder stage, src -> dist, including dist/generated/prisma/*.js) → prune
# devDependencies (prod-deps stage) → run dist/server.js (runtime stage).
# generate MUST run before build: the generated Prisma client under
# src/generated is tsc's input.
#
# IMPORTANT: `make migrate` rebuilds and reuses the `deps` stage directly (via
# `docker build --target deps`) to run `prisma migrate deploy` inside the
# compose network — it needs the prisma CLI + prisma/ + prisma.config.ts, all
# only present in `deps`'s full (unpruned) node_modules. Do not prune `deps`
# itself; prune only happens in the separate `prod-deps` stage below, which
# `runtime` copies from instead.

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
# Full service source, including the src/generated/prisma client from deps stage
COPY services/users/src ./src
COPY services/users/tsconfig.json ./
RUN node_modules/.bin/tsc -p tsconfig.json

# ── prod-deps stage: prune devDependencies (prisma CLI, typescript, @types/*, tsx, vitest, eslint) ──
FROM deps AS prod-deps
# `pnpm deploy` (not `pnpm prune`: in this pnpm version, `prune` on a
# filter-installed workspace subset prompts to reinstall the modules
# directory "from scratch" and — with no TTY to confirm — silently no-ops,
# leaving devDependencies in place). `deploy` instead assembles a
# self-contained, production-only copy of @3mrai/users into a target
# directory by cloning packages straight from the local pnpm content-store
# (already populated by `deps`'s install above — no network needed), which
# reliably excludes devDependencies while keeping @prisma/client's runtime
# deps. Runs from a copy of `deps` (this stage is `FROM deps`), so `deps`
# itself stays full/unpruned for `make migrate` (see the header comment above).
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
# Shared gRPC contract: the gRPC server (dist/shared/grpc/server.js) loads
# proto/users.proto at runtime via a path resolved five levels up from its own
# dir → /app/proto/users.proto. It is NOT part of dist/, so copy it explicitly,
# else the container crashes at boot with ENOENT '/app/proto/users.proto'.
COPY proto/users.proto /app/proto/users.proto
WORKDIR /app/services/users
EXPOSE 3000
# Plain `node` against the compiled build — no --experimental-strip-types, no
# --conditions=development. The package.json "imports" (#shared/*, #features/*)
# fall back to their "default" condition when no matching condition is active,
# resolving to ./dist/shared/*.js and ./dist/features/*.js (verified: node
# dist/server.js starts and listens without --conditions).
# --import loads the OTel bootstrap in its OWN module graph, before the app's
# graph is resolved. This service is ESM ("type": "module"), where every static
# import is hoisted and resolved before any module body runs — so importing the
# SDK "first" inside server.ts still left @grpc/grpc-js loaded by the time
# sdk.start() ran, and the gRPC server went uninstrumented (no server spans, so
# a trace from Orders could never continue into this service). --import is
# OpenTelemetry's supported answer for ESM.
CMD ["node", "--import", "./dist/shared/observability/tracing.js", "dist/server.js"]
