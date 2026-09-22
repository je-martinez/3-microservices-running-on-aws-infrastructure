---
name: local-env-lifecycle
description: 'Use whenever the local 3MRAI stack needs to come up, go down, be reset, resumed after a failed run, or have its Terraform/env-file state refreshed — "levanta el stack", "empieza de cero", "el bootstrap fallo a la mitad", "reaplica terraform", "redeploy the lambdas", "nothing is working locally", "why is bootstrap so slow". Picks the right make target for the situation and names the ones that will silently do the wrong thing, because several targets here look interchangeable and are not: one cannot be re-run at all, one is a resume path, and the cheapest reset is not the one most people reach for.'
metadata:
  area: infra
  source: Makefile + docs/lessons/2026-09-09-makefile-orchestration-invariants.md
  verified: 2026-09-22
---

# Local environment lifecycle

The Makefile has ~47 targets. This skill covers the ones that create, destroy or
repair local environment state, and exists because **the obvious choice is often
the wrong one**: `bootstrap-provision` cannot be re-run, `clean` is not the
cheapest reset, and a stack that looks broken is usually one missing step rather
than a reason to start over.


## Decide in one pass

Start from the situation, not the target:

| Situation | Command | Why this one |
|---|---|---|
| Fresh clone, or genuinely from scratch | `make bootstrap` | The whole chain in dependency order |
| Day-to-day reset with new code | `make clean-state && make bootstrap` | Keeps the build cache — 3m33s vs 4m57s |
| Suspect corrupt state or a stale layer | `make clean && make bootstrap` | The full reset; also reclaims the build cache and dangling images |
| A `bootstrap` died **at or after `migrate`** | `make doctor` → `make bootstrap-converge` → `make post-infra` | Phase 2 died; resume it. All three steps — converge does not call post-infra |
| A `bootstrap` died **during `infra-up`** | `make clean && make bootstrap` | Phase 1 died, and it cannot be re-run. The one case the expensive reset is right |
| Changed service source (Go, .NET, TS) | `docker compose up -d --build <svc>` | Rebuilds that one service; no teardown needed. Services are `users`, `orders`, `tracking`, `web` |
| Changed a `.tf` file, stack running | `make infra-up` | Applies + regenerates every env file |
| Changed a `.tf` file **and** doing a reset | `make clean-state && make bootstrap` | `bootstrap` runs `infra-up` itself — no separate apply |
| Env files look stale or wrong | `make env-file` | Pure read of Terraform outputs; never applies |
| Changed Lambda source | `make redeploy-lambdas` | `compose` does NOT redeploy Lambdas |
| Changed something under `assets/` | `make assets-sync` | Re-uploads only; touches no infrastructure |
| Changed an `NG_APP_*` flag | `docker compose build web` | Inlined at build time; `restart` re-serves the old bundle |
| Coming back after `make down` | `make up` | State survived; containers just restart |
| "Nothing works" and you don't know why | `make doctor` | Read-only; tells you which step is missing |
| Just stopping for the day | `make down` | Containers only, state intact |

**What each phase contains**, since the resume path depends on knowing where it
died. Phase 1 (`bootstrap-provision`): Floci, `backend-up`, `infra-init`,
`infra-up` — which ends by calling `env-file`. Phase 2 (`bootstrap-converge`):
`env-file`, `migrate`, `observability-up`, `warm-images`, `warm-nuget`, the four
service builds, `migrate-tracking`, and the nginx alias (`bootstrap.py`) last.
`post-infra` runs after both.

A full `make bootstrap` additionally starts `observability-up` **before**
`infra-up` — the apply invokes Lambdas, and with no collector every export
writes an `ENOTFOUND` stack trace. Converge calls it again, which is a no-op on
that path and the guarantee on a standalone resume.

Anything at or after `migrate` died in phase 2, so `bootstrap-converge` is the
resume. A failure during `infra-up` is phase 1, and that one has its own path
below.

## The three resets, and why picking wrong costs you

They are not interchangeable, and the difference is measured:

**`make down`** — stops containers. All state survives. Use it when you are done
for the day and want the stack back tomorrow as you left it.

**`make clean-state`** — removes the same state `clean` does (Floci volumes via
`down -v`, the `floci=true` volumes, tfstate, `.terraform`, the network) but
**keeps the Docker build cache**. The right default for "I changed code and want
a clean environment".

**`make clean`** — everything `clean-state` does, plus `docker image prune` and
`docker builder prune -af`. Reach for it when you suspect the build cache itself
is the problem ("works on a clean machine, fails on mine"), or when you want the
disk back — the prunes reclaim ~6.4GB of cache and ~2.2GB of dangling images,
which nothing else on the machine reclaims.

Measured, medians of a 3-run interleaved comparison on 2026-09-22, each figure a
full teardown **plus** the bootstrap after it:

| Cycle | Median |
|---|---:|
| `clean` + `bootstrap` | 4m57s |
| `clean-state` + `bootstrap`, sources untouched | 3m08s |
| `clean-state` + `bootstrap`, sources edited | 3m33s |

Those figures are current. They hold because `warm-images` and `warm-nuget` run
inside `bootstrap` and keep base images and NuGet packages in tagged images that
the prunes cannot reach — before they existed, five consecutive `clean` cycles
degraded 6m13s → 12m35s as registries throttled the repeated fetches. That
history is why `clean` is the expensive option even though it now measures
stable: the mechanism is defused, not absent, and it is the reason those two
targets must keep running inside the chain.
See [[2026-09-22-a-pruned-cache-that-came-over-the-network-is-not-free]].

## When a bootstrap dies partway

This is the case where the instinct — start over — is the expensive wrong answer.

**Run `make doctor` first.** It is entirely read-only (every check is a SELECT, a
SHOW, an HTTP GET or a `docker inspect`) and it reports the one thing nothing else
surfaces: a database that exists while its tables do not, which is what a
bootstrap that died before `migrate-tracking` leaves behind.

Then resume with **`make bootstrap-converge`**, which re-runs phase 2 only:
env files, migrations, service builds, the nginx alias. Every step in it is
idempotent by design.

**Do not run `make bootstrap-provision` to retry.** Phase 1 is *not re-runnable* —
a second phase-1 apply fails against Floci on `UpdateTags` (JE-113). That split is
the entire reason `bootstrap-converge` exists as a separate target.

After a resume, run **`make post-infra`** yourself. `bootstrap-converge`
deliberately does not call it: post-infra reads phase-1 state through
`terraform_remote_state`, which a partial run may never have written, so a resume
would fail for a reason unrelated to what it is resuming.

If `infra-up` itself failed, it already retried once through `infra-reconcile`
(state lives in a bucket *inside* Floci, so a restart desyncs them in both
directions). A second failure is a real error — the message says
`make clean && make bootstrap`, and that is the honest answer. This is the one
case where the expensive reset is right: phase-1 state and Floci disagree in a
way no resume can repair.

**If `bootstrap-converge` itself fails**, read which step it died on. Its steps
are individually runnable and idempotent, so you can re-run just that one
(`make migrate`, `make migrate-tracking`, `docker compose up -d --build users`)
once you have fixed the cause. If it dies repeatedly at the same step with no
clear cause, that is the signal to fall back to `make clean-state && make
bootstrap` — you are no longer resuming, you are debugging.

**Confirm you are actually back** by re-running `make doctor`. It cross-checks
tables against databases and reports each check as OK or NO with the command
that would fix it, so a clean run is the evidence the resume worked.

## Refreshing Terraform and env files

`infra-up` = apply + `env-file`. Those env files are **generated, never
hand-edited**: Floci mints new Cognito/API-GW ids and reassigns RDS proxy ports on
every apply, so a hand-edited value is wrong by the next apply. Each file has an
AUTO-GENERATED box (rewritten every run) and a CUSTOM box (preserved) — put
overrides in CUSTOM. See [[env-files]].

- **`make infra-plan`** — see what an apply would do. Safe, read-only.
- **`make infra-up`** — apply, then regenerate every env file.
- **`make env-file`** — regenerate env files *without* applying. This is what you
  want when the stack is fine but a service is reading a stale value.
- **`make infra-output`** — print Terraform outputs (Cognito ids, API id). A state
  read; changes nothing.
- **`make post-infra`** — a separate Terraform root (the repo also calls this
  "phase 2", distinct from `bootstrap-converge`): the least-privilege app-users and the assets
  bucket. Requires a successful bootstrap first.

**`make redeploy-lambdas` is not optional after changing Lambda source.** Docker
compose rebuilds the services and does *not* redeploy the seven Lambda functions,
and the failure is silent: source correct, tests green, deployed function still
running the old zip. That shipped a real bug once.

## Symptom → cause

Environment-state failures that are already diagnosed, so they are worth
recognising rather than re-investigating:

| Symptom | Cause | Action |
|---|---|---|
| `getaddrinfo ENOTFOUND floci-docdb-…` | A teardown kept Floci's state volume, so it reports phantom clusters as `available` and Terraform creates nothing | `make clean-state` is enough — it runs `down -v` and sweeps the `floci=true` volumes. `make doctor` detects the drift |
| Service 500s with `Table 'tracking.tracking' doesn't exist` | The version table says migrated, the tables are gone, so `migrate-tracking` no-ops | `DROP TABLE tracking.schema_migrations`, re-run `make migrate-tracking` |
| `infra-up` takes ~93s and feels stuck | Six SQS operations at exactly 25s each — a **client-side** waiter in the AWS provider, not Floci | Expected, not a fault. See [[2026-09-21-a-round-invariant-delay-on-one-resource-type-is-the-client-not-the-server]] |
| Bootstrap slower every time you run it | Repeated `clean` re-fetches base images and NuGet packages; registries throttle a repeat client | Prefer `clean-state` |
| A changed `NG_APP_*` flag looks ignored | Angular inlines those at **build** time | `docker compose build web`, never `restart` |
| A deployed Lambda still runs old code | `compose` does not redeploy Lambdas, and it fails silently | `make redeploy-lambdas` |
| OpenObserve trace waterfall 400s (`code 20004`) | Its trace-detail endpoint queries a `gen_ai_*` field this repo never emits, and `make clean` wipes the seeded schema with the volume | `make observability-traces-schema` |

A 404 or a route reaching the wrong service is **not** a lifecycle problem — it
is gateway/nginx wiring, and the root `CLAUDE.md` covers it. The one thing worth
knowing here: a 404 carrying the gateway's own `{"message":"Not Found"}` never
reached the service at all, and after fixing the route a **401 is the good
answer**.

## Things that are load-bearing

Order inside `bootstrap` is not stylistic. The long `CONTRACT:` comments in the
Makefile record failures that each cost real debugging, so read them before
reordering anything. The short version:

- **`observability-up` runs before `infra-up`**, and is not opt-in. Every OTLP
  producer builds its exporter against `otel-collector:4318`; with the collector
  absent, every export writes a full `ENOTFOUND` stack trace, and the apply
  *invokes* Lambdas.
- **`infra-up` ends by calling `env-file`**, so every generated file exists before
  any service starts. Services read them via compose `env_file:`.
- **The nginx alias (`bootstrap.py`) runs last.** No service reads it — the API
  Gateway routes *through* it — so running it mid-chain skips everything after it
  on failure.
- **`post-infra` runs last, and `bootstrap` is the only chain that calls it
  automatically** — after a resume you run it yourself.

Full reasoning: [[2026-09-09-makefile-orchestration-invariants]].

## Before reaching for a reset

A stack that looks broken is usually one missing step, so climb this in order —
it is the decision table re-sorted by what each option costs you:

`make doctor` → `make ps` / `make logs S=<service>` → `make env-file` →
`make bootstrap-converge` → `make clean-state && make bootstrap` →
`make clean && make bootstrap`

Starting at the bottom is the common mistake: it is the slowest option, it
throws away caches you will immediately rebuild, and on a repeated cycle it gets
slower each time. The first three cost seconds and resolve more failures than
their position suggests.
