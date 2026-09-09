---
title: "Makefile orchestration invariants: why the bootstrap chain is ordered the way it is"
type: lesson
area: infra
status: active
created: 2026-09-09
updated: 2026-09-09
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[env-files]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[two-phase-terraform-apply]]"
  - "[[terraform-remote-state-backend]]"
  - "[[2026-07-30-post-infra-root-design]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[2026-09-09-migration-version-tables-lie-about-schema]]"
---

# Makefile orchestration invariants: why the bootstrap chain is ordered the way it is

The root `Makefile`'s bootstrap chain (`bootstrap` → `bootstrap-provision` /
`bootstrap-converge`) looks like an arbitrary sequence of targets but every hop encodes a
constraint that broke something real when it was violated. This note is the "why" that used to
live as long inline comment blocks inside those targets before the 2026-09-09 comment-convention
pass ([[code-comments]]) relocated the history here and left only present-tense prohibitions plus
one failure symptom at each call site. Read this before reordering, merging, or "simplifying" any
step in the chain.

## Lambda bundles must be built before any `terraform plan` or `apply`

`lambda-bundles` builds the esbuild bundles for `functions/events-pipeline` and
`functions/realtime-events` into their `dist/` directories. Both directories are **gitignored**
and absent on a fresh clone.

Terraform wires both Lambdas through `archive_file`, which is a **data source** — evaluated at
**plan time**, not apply time. Against a missing `dist/`, `terraform plan` (and therefore
`apply`) fails immediately with `could not archive missing directory`. This is a *good* failure
mode compared to the alternative: it happens up front, before any resource is touched, rather
than as a late deploy failure that leaves a half-built stack.

`redeploy-lambdas` also builds these bundles, but it cannot substitute for `lambda-bundles` as a
plan/apply prerequisite: it runs against a stack that **already exists** (it deploys straight to
Lambda, bypassing Terraform, because a second phase-1 apply fails on Floci's `UpdateTags` — see
[[floci-rds-apigw-limits]]). On a fresh clone there is no stack yet, so `redeploy-lambdas` is not
reachable at that point. This is why `lambda-bundles` is its own target and why both `infra-plan`
and `infra-up` declare it as a prerequisite rather than relying on `redeploy-lambdas` to cover the
case.

`lambda-bundles` also runs `pnpm install --frozen-lockfile`. No earlier target in the chain
installs `node_modules` — the three backend services build inside Docker and the Python tooling
uses the repo venv (`scripts-setup`), so this is the only place `node_modules` gets installed
before a build needs it. `--frozen-lockfile` (never plain `install`) is deliberate: a bootstrap
run must fail loudly on a lockfile drift rather than silently resolve a new dependency tree.

## The `infra-reconcile` retry is bounded, not a loop

`infra-up` wraps its `terraform apply` as `apply || infra-reconcile`. This exists because
Terraform's state for the local environment lives in a bucket **inside Floci itself** (see
[[terraform-remote-state-backend]]), so anything that restarts or half-destroys the emulator
leaves state and reality disagreeing in **both directions**:

- state has a resource, Floci does not → `NotFoundException: Invalid API id`
- Floci has a resource, state does not → `EntityAlreadyExists`

A bare `apply` reports whichever error surfaces first and stops, which makes bootstrap fail
naming an unrelated resource rather than describing the actual problem — and invites hand-editing
state, which is how the second failure mode gets created from the first.

`infra-reconcile` runs exactly two steps and is not a retry loop:

1. `terraform apply -refresh-only -auto-approve` — rereads every resource and drops the ones that
   no longer exist. This fixes the "state has it, Floci does not" direction without a manual
   `state rm`.
2. One more `terraform apply -auto-approve`.

If that second apply also fails, it is treated as a **real error**, not retried again. The
message printed at that point is `make clean && make bootstrap` — a full rebuild — because the
remaining failure mode (Floci holds a resource the state has forgotten) cannot be repaired by a
refresh. **Do not hand-repair that direction**: removing a state entry for a resource that
**does** exist produces the opposite error (`EntityAlreadyExists`) on the very next apply. There
is no safe manual fix short of tearing the stack down.

## Observability starts before the terraform apply, not after

`bootstrap` calls `observability-up` **before** `infra-up`. Every OTLP producer in this repo
(all three services, both Lambdas) constructs its exporter in code against
`otel-collector:4318` (see [[ADR-0019-distributed-tracing-opentelemetry]]). The `infra-up` step
**invokes Lambdas** as part of the apply. With the collector absent at that point, every export
attempt writes a full `getaddrinfo ENOTFOUND otel-collector` stack trace — measured at 8 traces
in 2 minutes from Users alone on an otherwise idle stack — and Lambda stderr reaches CloudWatch
tagged `ERROR`, which fails `unclassified-logs.spec.ts`.

Moving `observability-up` after the apply, or trying to suppress the failure by unsetting the
OTLP env vars instead, does not work: an explicitly-constructed SDK exporter (which is what this
repo uses) beats `OTEL_TRACES_EXPORTER` in precedence, so disabling the env var reproduces the
identical `ENOTFOUND`. A measured 46-second delay in starting the collector cost exactly one red
spec. The fix is making the hostname **resolve**, which means the collector must already be
running before anything that talks to it starts.

## The nginx alias script runs last

`bootstrap.py` (which creates the `nginx-stable` DNS alias the API Gateway routes through) is the
final step of `bootstrap-converge`, deliberately. No service reads the alias directly — the
gateway routes **through** it — so if it ran mid-chain and failed, every target after it would be
skipped. That is exactly how a cold bootstrap once produced Tracking's database with none of its
tables (JE-112): the alias step failing partway through the chain skipped `orders`,
`migrate-tracking`, and `tracking` entirely, silently.

Running it last also means its blast radius is limited to itself: by the time it runs, `users`
has had the whole `orders`/`tracking` build to finish booting, so `bootstrap.py`'s health poll on
`users` succeeds on the first attempt instead of racing a container that started seconds earlier.

## The web container build comes after the services

`bootstrap-converge` builds the `web` container with `--build`, and does so after `users`,
`orders`, and `tracking` are already up — never as a plain `restart`. The web app's `NG_APP_*`
values are **inlined at build time** by the Angular build, not read at runtime. A `restart`
re-serves the exact same bundle, so a changed flag looks silently ignored; only a rebuild picks
up new values. Ordering it after the backend services (rather than in parallel or first) is not
load-bearing for correctness the same way — it is just where it naturally falls in the resume
path — but it must stay a `--build` step, always.

## Bootstrap is split into two phases for a re-run reason

`bootstrap-provision` (Floci → terraform → env files) is **not safely re-runnable**: a second
phase-1 `terraform apply` fails against Floci on `UpdateTags` (JE-113). `bootstrap-converge`
(migrations → services → nginx alias) is deliberately kept **idempotent end to end** — Prisma and
golang-migrate both no-op at head, `docker compose up -d` reconciles running containers rather
than recreating them, and `bootstrap.py` returns early once the alias already resolves — so it
exists as a safe **resume path** for a `bootstrap` that died partway through phase 2, without ever
re-entering the phase-1 apply that cannot succeed twice.

This is also why `bootstrap-converge` calls `env-file` again even though `infra-up` already called
it once: on a full `bootstrap` run that second call is a sub-second no-op (it only rereads
Terraform outputs, never applies), but it is what makes `bootstrap-converge` work as a
**standalone** entry point rather than only as a continuation of `bootstrap`. Dropping it would
mean `migrate-tracking` (which reads `DATABASE_WRITER_URL` from `.env.local.tracking`) fails
whenever `bootstrap-converge` is invoked directly.

`post-infra` (phase 2 proper — see [[two-phase-terraform-apply]] and
[[2026-07-30-post-infra-root-design]]) stays **outside** `bootstrap-converge` for the same reason
in reverse: it reads phase-1 state through `terraform_remote_state`, which a partial run may
never have written, so folding it into the resume path would make `bootstrap-converge` fail for a
reason unrelated to what it is resuming. It is called only from `bootstrap` itself, last, after
`bootstrap-converge` completes.

## `clean` must remove Floci-launched containers and volumes explicitly

`docker compose down` only knows about containers and volumes declared in `docker-compose.yml`
with the project's compose label. Floci launches its own backing containers (RDS proxies,
DocumentDB, ElastiCache) through the mounted Docker socket, so they carry **no compose project
label** — `down` never sees them and `--remove-orphans` does not catch them either. Left behind,
a stale Floci-launched container holds the shared network open, so `down` reports `Network
3mrai_3mrai-network Resource is still in use` and the next `bootstrap` builds on a network it did
not create. `clean` therefore removes `floci-`-prefixed containers and `floci=true`-labelled
volumes by explicit filter, in addition to the normal compose teardown. See
[[floci-recreate-destroys-backing-containers]] for the deeper failure mode this guards against
(state surviving a teardown and lying about resources that no longer exist).

## The general shape

Every constraint above reduces to one of three things: a Terraform data source that runs before
the thing it depends on exists (lambda bundles), a hostname that must already resolve before the
code that needs it starts (observability), or a step whose partial failure has a blast radius
larger than itself unless it runs last (the nginx alias, phase 2). Reordering any of these without
re-verifying the failure mode it was placed to avoid reintroduces a class of bug that already cost
debugging time once — JE-112 and JE-113 are both on record. When in doubt, treat the current order
in `Makefile` as load-bearing, not stylistic.

## Related

- [[env-files]] — the generated env-file convention `env-file`/`infra-up` depend on; both write
  their AUTO-GENERATED box and preserve CUSTOM.
- [[floci-rds-apigw-limits]] — the `UpdateTags` limitation that makes `redeploy-lambdas` a
  separate, non-Terraform deploy path and phase-1 non-re-runnable.
- [[two-phase-terraform-apply]] — the phase-1/phase-2 split this note's `post-infra` section
  depends on.
- [[terraform-remote-state-backend]] — why local Terraform state lives inside Floci and desyncs
  on emulator restarts, which is what `infra-reconcile` exists to repair.
- [[2026-07-30-post-infra-root-design]] — why `post-infra` is its own root with its own state
  rather than folded into phase 1 or into `bootstrap-converge`.
- [[floci-recreate-destroys-backing-containers]] — the deeper Floci state-persistence failure
  that motivates `clean`'s explicit Floci container/volume sweep.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the OTLP/OpenObserve design that makes
  `observability-up` a hard ordering dependency of `infra-up`, not an optional add-on.
- [[2026-09-09-migration-version-tables-lie-about-schema]] — the companion lesson on why
  `migrate-tracking`'s placement inside `bootstrap-converge` is necessary but not sufficient for
  a correct schema.
