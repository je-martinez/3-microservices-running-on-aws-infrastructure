# events-pipeline — react-email PREVIEW SERVER only. The pipeline itself is a
# Lambda deployed by Terraform as a zip (see CLAUDE.md §1-2); nothing here runs
# it. Behind compose's `preview` profile, so `make up` never builds it.

# CONTRACT: Build context is the REPO ROOT. A context of
# ./functions/events-pipeline cannot see pnpm-lock.yaml, so `--frozen-lockfile`
# becomes impossible.

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
# CONTRACT: Keep `@react-email/preview-server` declared in package.json at an
# EXACT version equal to the resolved `react-email`. Left to the CLI, or pinned
# with a `^`, `email dev` prompts to install it; with no TTY the prompt resolves
# at once and the container exits 0 with an empty log, serving nothing.
# See [[2026-09-30-a-tty-less-prompt-resolves-to-a-silent-success]]
RUN pnpm install --frozen-lockfile --filter @3mrai/events-pipeline...
WORKDIR /app/functions/events-pipeline
# Only the templates and the manifest are needed — `email dev` reads emails/ and
# nothing under src/. The compose `develop.watch` block syncs emails/ into this
# same path so edits hot-reload without a rebuild.
COPY functions/events-pipeline/emails ./emails
EXPOSE 3000
# `pnpm run email` → `email dev --dir emails --port 3000` (see package.json).
CMD ["pnpm", "run", "email"]
