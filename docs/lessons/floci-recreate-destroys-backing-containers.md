---
title: "Floci's persisted state must be destroyed together with its backing containers"
type: lesson
area: infra
status: active
created: 2026-08-10
updated: 2026-08-10
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[floci-rds-apigw-limits]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[env-files]]"
---

# Floci's persisted state must be destroyed together with its backing containers

Empirical findings from a `make clean && make bootstrap` regression (2026-08-10). Recorded so
the next teardown/bootstrap change does not reintroduce a class of failure that presented as an
events-pipeline Lambda bug but was actually infra state corruption three layers deep.

## The failure

After a full `make clean && make bootstrap`, DocumentDB and ElastiCache reported
`Status: available` through the AWS API while having **no backing Docker container**. The
events-pipeline Lambda aborted every batch with
`getaddrinfo ENOTFOUND floci-docdb-db-3mrai-local-events-docdb`, so no email was ever sent and
19 E2E tests failed — OTP, password-reset, delivered-emails, and the tracking journey: every
test that waits on an email.

## Root cause

`make clean` prompted `Remove ./data (local emulator state)? [y/N]` and **defaulted to
keeping it**. That left three layers desynchronised:

- Terraform state: destroyed
- Backing containers (docdb, valkey, rds): destroyed by `compose down`
- Floci's persisted JSON state under `./data/floci`: **kept**

On the next bootstrap, Floci loaded that stale state and answered `available`. Terraform asked
"does this cluster exist?", was told yes, and **created nothing** while reporting success.

> [!bug] Hard evidence
> Zero `CreateDBCluster` calls in the entire startup log — only three `Describe` calls. The
> Floci log showed `PersistentStorage: Loaded 1 entries from /app/data/docdb-clusters.json` at
> boot, and the on-disk JSON carried a `createdAt` from the **previous** session.

## Why it looked intermittent

Floci relaunches RDS containers from persisted state at boot — visible as
`RdsContainerManager: Starting RDS backend container for instance: … engine=POSTGRES`. It has
**no equivalent reconciler for DocumentDB or ElastiCache**: those load their state and launch
nothing. A single teardown therefore left Postgres/MySQL healthy and the other two phantom,
which is why the same command appeared to work some of the time — the failure depends on which
resource types Floci actually reconciles at boot, not on any randomness.

## Why compose could not fix it

`./data/floci` was a **bind mount**. `docker compose down -v` removes named volumes but
**cannot** remove bind mounts. No compose command cleared this state — it could only be deleted
by hand, behind a prompt whose default kept it.

## The fix (applied and verified)

1. **State moved to named volumes.** Floci's state now lives in the `floci-state` named
   volume; OpenObserve's `./data/openobserve` likewise moved to `openobserve-data`. General
   rule established: runtime-generated state goes in a named volume, never a `./data` bind
   mount. Versioned files a container only *reads* (e.g. the otel-collector config YAML,
   mounted `:ro`) correctly stay bind mounts — those are source, not state.
2. **`make clean` is now unconditionally destructive.** It runs `docker compose down -v` with
   no prompt. This is a deliberate behaviour change: clean no longer asks before wiping state.
3. **`make doctor` gained drift detection.** `check_phantom_resources` and `check_docdb_host`
   cross-check every declared DocumentDB/ElastiCache resource against `docker ps` and fail with
   exit 1 when state and reality disagree.

> [!success] Verified
> A full `make clean && make bootstrap` with the new config created all four backing containers
> (docdb, valkey, both RDS) on the first attempt, and the full E2E suite went 114/114 — up from
> 19 failures.

## Two traps for future sessions

1. **Do not read the DocumentDB cluster list from `aws docdb describe-db-clusters`.** Floci
   returns the RDS clusters (mysql, postgres) there and omits the DocumentDB one entirely, so a
   drift check built on it produces false phantoms **and** misses the real one. This was
   measured — the first version of the `make doctor` check did exactly this and reported two
   phantoms on a healthy stack. Check the generated `DOCDB_HOST` in
   `.env.local.events-pipeline` instead (see [[env-files]]) — it **is** the container name.
2. **Recovering a single phantom without a full rebuild:** delete it via its own API
   (`aws docdb delete-db-cluster --skip-final-snapshot`,
   `aws elasticache delete-replication-group`), then `terraform taint` the module's
   `terraform_data.*_via_cli` resource and re-apply that target. A plain
   `terraform apply -target` does **nothing** — the awscli-fallback resources only re-run when
   their trigger changes.

## General principle

An emulator's control-plane state and the containers backing it are one unit; a teardown that
removes one and keeps the other produces resources that lie about existing. Terraform cannot
detect this — it trusts the API. The failure surfaces far from its cause, at runtime, in an
unrelated service.

## Related

- [[floci-rds-apigw-limits]] — the earlier lesson on Floci's RDS reconciliation quirks
  (non-deterministic proxy ports); this note extends the same "verify Floci's actual behaviour,
  don't trust the API's word" discipline to full teardown/bootstrap cycles.
- [[floci-storage-modes-and-tmp-corruption]] — a different Floci persistence failure mode
  (truncated `.tmp` state files); together these two notes cover the two ways Floci's on-disk
  state can silently diverge from reality.
- [[floci-sqs-lambda-docdb-support]] — the DocumentDB support surface the events-pipeline Lambda
  depends on, and the service that surfaced this bug via `ENOTFOUND`.
- [[floci-vs-ministack-spike-findings]] — the original spike that chose Floci as the local AWS
  emulator; this lesson is an operational finding on the tool that spike selected.
- [[env-files]] — the generated env-file convention; `DOCDB_HOST` in
  `.env.local.events-pipeline` is the value the fixed `make doctor` check now trusts instead of
  the DocumentDB describe API.
