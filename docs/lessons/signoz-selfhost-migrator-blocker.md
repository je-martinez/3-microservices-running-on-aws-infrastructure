---
title: "SigNoz self-hosted stack blocked on schema-migrator hang"
type: lesson
area: shared
status: active
created: 2026-07-10
updated: 2026-07-10
tags: [type/lesson, area/shared, status/active, severity/medium]
related:
  - "[[2026-07-10-signoz-logs-observability-design]]"
  - "[[2026-07-10-signoz-logs-observability]]"
  - "[[ADR-0011-observability-signoz]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[openobserve-cloudwatch]]"
---

# SigNoz self-hosted stack blocked on schema-migrator hang

Diagnosis and resumption notes for a blocker hit implementing Task 3 (self-hosted SigNoz) of
[[2026-07-10-signoz-logs-observability]]. Verified live 2026-07-10. Written so the work can
resume without re-discovering the root cause.

> [!warning] Task 3 is blocked — Tasks 1-2 are done and committed
> The log-capture pipeline (the core ask) works end-to-end. Only the SigNoz visualization
> backend (Task 3) is blocked, which in turn blocks Task 4 (end-to-end UI verification).

## What works (delivered, committed)

Tasks 1 and 2 of [[2026-07-10-signoz-logs-observability]] are done and committed (commits
`0ac1195`, `2967923`):

- **Task 1** — an `otel/opentelemetry-collector-contrib:0.156.0` service behind the compose
  `observability` profile, with two receivers: `fluent_forward` (`:24224`) and
  `aws_cloudwatch` (polls Floci's `/ecs/` via `AWS_ENDPOINT_URL`). Verified live: it ingests
  real `/ecs/3mrai-local-compute-nginx` LogRecords from Floci.
- **Task 2** — the four services (`users`, `orders`, `tracking`, `events-pipeline`) route
  stdout to the collector via Docker's `fluentd` log-driver, with `fluentd-async: "true"` so
  they start whether or not the collector is up. Verified: `users` boots and serves with the
  collector off.

So the LOG-CAPTURE pipeline (the user's core ask) works. What's missing is only the SigNoz
visualization backend.

## The blocker — Task 3, self-hosted SigNoz

Vendoring SigNoz's self-hosted compose does **not** start autonomously. Diagnosis, in order of
what was ruled out:

- SigNoz's self-hosted compose lives at `deploy/docker/docker-compose.yaml` only up to
  ~v0.90.1 (later tags dropped it for the "Foundry" CLI; the old
  `deploy/docker/clickhouse-setup/` path is gone — 404 on every tag).
- v0.90.1 pins: `clickhouse:24.1.2-alpine`, `zookeeper:3.7.1`, `signoz/signoz:v0.90.1`
  (UI+query, port 8080), `signoz/signoz-otel-collector:v0.128.2`,
  `signoz/signoz-schema-migrator:v0.128.2`.
- ClickHouse and Zookeeper start healthy. The **schema-migrator hangs**: it connects to
  ClickHouse but logs `"Up migrations","versions":[]` and never creates any `signoz_*`
  database (ClickHouse keeps only `default`/`system`/`information_schema`). Without the
  tables, the `signoz` UI service never starts (it waits on the migrator completing).
- The migrator image `v0.128.2` (and `v0.111.39`, tested) reports zero embedded migration
  versions.
- **Root cause understanding:** recent SigNoz moved schema-migration logic out of the
  standalone migrator into the main service; the standalone-migrator self-host compose is
  effectively broken for autonomous bring-up. This is a SigNoz packaging issue, **not** our
  compose config — DSN, service names, and vendored config files under
  `observability/signoz/common` were all correct.
- The community all-in-one image (`jsonbored/signoz-aio`) was **not** pullable.

## Options to resume (pick one next session)

1. **SigNoz Cloud** — point the Task-1 collector's `otlp` exporter at
   `ingest.<region>.signoz.cloud:443` with a `signoz-ingestion-key`. Zero local backend, no
   migrator. Needs an account + key; sends local logs to the cloud.
2. **Run SigNoz's own compose standalone** — clone the SigNoz repo and run its stack with ITS
   OWN `docker compose up` from its directory (not merged into ours), then point our collector
   at that network. Manual, but runs migrations the way SigNoz's own orchestration expects.
3. **A newer SigNoz version** whose self-host bring-up actually applies migrations (verify the
   migrator creates `signoz_*` tables before wiring the UI).

## State left in the repo

Task 3's half-done vendoring was reverted from the working tree (`docker-compose.yml` back to
the Tasks 1-2 state; `observability/signoz/` deleted). The Task-1 collector config
(`observability/otel-collector-config.yaml`) and the plan/spec remain. The plan's Task 3 and
Task 4 are unimplemented.

## Related

- [[2026-07-10-signoz-logs-observability-design]]
- [[2026-07-10-signoz-logs-observability]]
- [[ADR-0011-observability-signoz]]
- [[ADR-0018-observability-openobserve]]
- [[openobserve-cloudwatch]]
