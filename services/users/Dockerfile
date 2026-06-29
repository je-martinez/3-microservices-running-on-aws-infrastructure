# Users service — Fastify + Node 24 (pinned via repo .nvmrc), pnpm via corepack.
# Build context: REPO ROOT (pnpm-lock.yaml and pnpm-workspace.yaml live there).
# Multi-stage:
#   base    → common Node/pnpm setup
#   deps    → install workspace deps (including devDeps needed for tsc)
#   build   → run prisma generate + tsc, producing dist/ and .prisma/client engine
#   runtime → lean final image that runs node dist/server.js

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Prepare the exact pnpm version pinned in the root package.json (packageManager).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps stage: install ALL workspace deps (prod + dev) for @3mrai/users ────
# devDeps (typescript, @types/node) are required here so tsc can compile.
FROM base AS deps
# Root workspace manifests (lockfile + workspace yaml + root package.json)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Service manifest (needed so pnpm can resolve the filter)
COPY services/users/package.json ./services/users/
# Allow Prisma engine build scripts (needed for prisma generate later).
# Include devDependencies so tsc / typescript are available in the build stage.
RUN pnpm install --frozen-lockfile --filter @3mrai/users... --config.ignore-scripts=false

# ── build stage: compile TypeScript source to dist/ ─────────────────────────
FROM deps AS build
# Copy full service source (prisma schema + src + tsconfig)
COPY services/users ./services/users
WORKDIR /app/services/users
# Generate Prisma client (creates native engine binary under node_modules/.prisma/client).
# This must run before tsc so the generated types are available.
RUN node node_modules/prisma/build/index.js generate --schema=./prisma/schema.prisma
# Compile TypeScript → dist/ (outDir defined in tsconfig.json).
# .js import specifiers in the source are correct for NodeNext ESM output.
RUN node_modules/.bin/tsc -p tsconfig.json

# ── runtime stage: lean final image ─────────────────────────────────────────
FROM base AS runtime
# Copy installed node_modules from deps stage (prod packages)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/services/users/node_modules ./services/users/node_modules
# Copy the generated Prisma client engine (built in the build stage) into
# the runtime node_modules. prisma generate writes native binaries to
# node_modules/.pnpm/@prisma+client.../node_modules/.prisma/client — those
# binaries are NOT present in the deps stage (only JS stubs are), so we must
# overlay them from the build stage.
COPY --from=build /app/node_modules/.pnpm /app/node_modules/.pnpm
# Copy prisma schema (needed at runtime for Prisma client engine resolution)
COPY --from=build /app/services/users/prisma ./services/users/prisma
# Copy compiled JS output from the build stage
COPY --from=build /app/services/users/dist ./services/users/dist
WORKDIR /app/services/users
EXPOSE 3000
# Run the compiled output — no --experimental-strip-types needed.
# .js import specifiers resolve correctly because tsc emitted .js files.
CMD ["node", "dist/server.js"]
