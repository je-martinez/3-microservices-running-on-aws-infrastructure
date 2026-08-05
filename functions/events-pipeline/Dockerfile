# events-pipeline — react-email PREVIEW SERVER only.
#
# This image does NOT run the pipeline. The pipeline is a real Lambda on Floci,
# deployed by Terraform as a zip built by `pnpm run build` (see
# functions/events-pipeline/CLAUDE.md §1-2) — there is no container in its
# runtime path, locally or in AWS, and docker-compose.yml deliberately has no
# `events-pipeline` service any more.
#
# What it is for: `email dev`, react-email's preview server, so the templates
# under emails/ can be viewed and hot-reloaded in a browser without installing
# the toolchain on the host. It sits behind compose's `preview` profile, so a
# normal `make up` never builds or starts it.
#
# Build context: REPO ROOT (pnpm-lock.yaml and pnpm-workspace.yaml live there),
# same as services/users/Dockerfile — a context of ./functions/events-pipeline
# cannot see the lockfile, so `--frozen-lockfile` would be impossible.

FROM node:24-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# The exact pnpm version pinned in the root package.json (packageManager).
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ── preview stage: react-email dev server ────────────────────────────────────
FROM base AS preview
# Root workspace manifests first, so the install layer is cached independently
# of the template sources that change on every edit.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY functions/events-pipeline/package.json ./functions/events-pipeline/
# devDependencies INCLUDED on purpose: `react-email` (the `email` CLI) and
# `@react-email/preview-server` are both devDependencies, and this stage exists
# to run them.
#
# @react-email/preview-server is declared explicitly in package.json rather than
# left to the CLI: `email dev` does NOT bundle its preview UI. On first run it
# detects the package is missing and PROMPTS to install it — and with no TTY
# (this container, or CI) the prompt resolves immediately, so the process exits
# 0 having started no server at all. `docker build` cannot catch that, because
# the build succeeds; only running the image reveals it. Verified here: the
# container exited 0 with an empty log until the dependency was declared.
#
# It is pinned to an EXACT version (4.3.2), not a caret range, and that version
# must equal the resolved `react-email` version: the CLI compares the two and
# re-prompts (same silent exit) if they differ. A `^` here let pnpm resolve
# 5.2.10 against react-email 4.3.2 and reproduced the failure exactly. When
# bumping react-email, bump this in lockstep.
RUN pnpm install --frozen-lockfile --filter @3mrai/events-pipeline...
WORKDIR /app/functions/events-pipeline
# Only the templates and the manifest are needed — `email dev` reads emails/ and
# nothing under src/. The compose `develop.watch` block syncs emails/ into this
# same path so edits hot-reload without a rebuild.
COPY functions/events-pipeline/emails ./emails
EXPOSE 3000
# `pnpm run email` → `email dev --dir emails --port 3000` (see package.json).
CMD ["pnpm", "run", "email"]
