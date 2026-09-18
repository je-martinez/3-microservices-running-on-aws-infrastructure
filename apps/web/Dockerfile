# Web app — Angular + Tailwind SPA on Node 24, served as STATIC FILES by nginx.
# Build context is the REPO ROOT, where the pnpm lockfile and workspace live.

# Multi-stage: deps installs the @3mrai/web closure; builder runs `ng build`
# emitting dist/web/browser; runtime is plain nginx — NO Node, because
# angular.json declares no `ssr`/`server`. SSR would be a different image.

# CONTRACT: NG_APP_* are BUILD ARGS, never runtime env. @ngx-env inlines them at
# compile time, so a runtime variable is read by nothing and the container keeps
# serving the compiled value with no error. Changing one needs a rebuild:
# `docker compose build web && docker compose up -d web`. A restart re-serves
# the same bundle and reads exactly like the flag being ignored.
# See [[web-app-env-config]]

# Declared before FROM so every stage sees it; an ARG's scope ends at the next
# FROM, hence the re-declaration in builder. Default matches .env.example.
ARG NG_APP_STRIPE_ENABLED=false
# CONTRACT: EVERY NG_APP_* the app reads needs an ARG here AND an ENV in the
# builder stage. @ngx-env only inlines variables present at build time; one it
# cannot see is left as a live `import.meta.env` lookup, which is undefined in a
# browser and throws before Angular boots — a blank page, not a missing flag.
# See [[2026-09-04-web-gateway-integration-design]]
ARG NG_APP_API_GATEWAY_URL=/v1
# A FLAG, never the key. The Geoapify key is server-side only (nginx appends it
# in apps/web/nginx.conf); this only tells the app whether to offer the
# autocomplete at all. Default false so an unconfigured checkout gets the plain
# address input rather than a field that 503s on every keystroke.
ARG NG_APP_GEOCODE_ENABLED=false
ARG NG_APP_WS_URL=

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Prepare the exact pnpm version pinned in the root package.json (packageManager).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── deps stage: install the workspace deps for @3mrai/web ────────────────────
FROM base AS deps
# Root workspace manifests (lockfile + workspace yaml + root package.json)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# App manifest (needed so pnpm can resolve the filter)
COPY apps/web/package.json ./apps/web/
# `--filter @3mrai/web...` installs this package and its workspace closure.
# devDependencies are REQUIRED here and must not be pruned: @angular/cli,
# @angular/build, @ngx-env/builder, tailwindcss and typescript are all
# devDependencies, and all of them are the build. Nothing is pruned anywhere in
# this file because the runtime stage carries no node_modules at all — it is
# nginx serving files.
RUN pnpm install --frozen-lockfile --filter @3mrai/web...

# ── builder stage: ng build → dist/web/browser ───────────────────────────────
FROM deps AS builder
# Re-declare to bring the global ARG into this stage's scope, then promote it to
# an ENV so the Angular build process actually sees it (@ngx-env reads
# process.env). ARG alone is visible to RUN's shell but this makes the intent
# explicit and matches the pattern in @ngx-env/builder's own Docker docs.
ARG NG_APP_STRIPE_ENABLED
ENV NG_APP_STRIPE_ENABLED=$NG_APP_STRIPE_ENABLED
ARG NG_APP_API_GATEWAY_URL
ENV NG_APP_API_GATEWAY_URL=$NG_APP_API_GATEWAY_URL
ARG NG_APP_GEOCODE_ENABLED
ENV NG_APP_GEOCODE_ENABLED=$NG_APP_GEOCODE_ENABLED
ARG NG_APP_WS_URL
ENV NG_APP_WS_URL=$NG_APP_WS_URL
# Source and build configuration. public/ holds favicon.ico (angular.json
# `assets`), styles/tsconfig drive the compile. apps/web/design is NOT copied —
# it is 2MB of static HTML design references for humans, excluded in
# .dockerignore and never served.
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY apps/web/angular.json apps/web/tsconfig.json apps/web/tsconfig.app.json apps/web/.postcssrc.json ./apps/web/
WORKDIR /app/apps/web
# `ng build` with angular.json's defaultConfiguration: production — optimization,
# outputHashing "all" (which the nginx cache rules depend on), and the bundle
# budgets, so an oversized bundle fails the image build rather than shipping.
RUN pnpm exec ng build

# ── runtime stage: nginx serving the static build ───────────────────────────
FROM nginx:1.27-alpine AS runtime
# Server block only — the stock nginx.conf in this image includes conf.d/*.conf
# from inside its http{} block. See apps/web/nginx.conf for the SPA fallback,
# which is what makes a refresh on /orders work instead of 404ing, and for the
# /v1/ same-origin proxy that removes the need for CORS.
#
# CONTRACT: Land it under /etc/nginx/templates, NOT conf.d. The image's
# 20-envsubst-on-templates.sh entrypoint renders *.template into conf.d at
# start, which is how the per-apply gateway id reaches nginx. Copied straight
# to conf.d it would ship with ${API_GATEWAY_*} unexpanded and fail to start.
COPY apps/web/nginx.conf /etc/nginx/templates/default.conf.template
# CONTRACT: Do NOT drop or broaden this filter. envsubst substitutes EVERY
# exported variable it finds, so without it nginx's own $uri/$host/$request_uri
# render empty and the SPA fallback silently serves nothing. Widen it only by
# adding an ANCHORED prefix to the alternation — the entrypoint matches this as
# an unanchored awk regex, so a bare name would match far more than intended.
ENV NGINX_ENVSUBST_FILTER='^(API_GATEWAY_|GEOAPIFY_)'
# The BROWSER subdirectory, not dist/web: the parent also holds
# 3rdpartylicenses.txt and prerendered-routes.json, which are build metadata and
# have no business being reachable over HTTP.
COPY --from=builder /app/apps/web/dist/web/browser /usr/share/nginx/html
EXPOSE 80
# nginx:alpine's own CMD already runs `nginx -g "daemon off;"` in the
# foreground; no override needed.
