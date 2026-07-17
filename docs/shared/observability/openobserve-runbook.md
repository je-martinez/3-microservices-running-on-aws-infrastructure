---
title: OpenObserve — Local Runbook
type: runbook
area: shared
status: active
created: 2026-07-10
updated: 2026-07-16
integration-status: verified
verified-on: 2026-07-10
verified-by: Jose E. Martinez
tags: [type/runbook, area/shared, status/active]
related:
  - "[[openobserve-cloudwatch]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[2026-07-10-openobserve-migration]]"
  - "[[local-dev]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
---

# OpenObserve — Local Runbook

## When to run this

Run this runbook to view local logs in OpenObserve. The log-capture pipeline is always wired —
the four services log via Docker's `fluentd` driver, made safe by `fluentd-async` so they start
whether or not the collector is running — but the OpenObserve backend and OTel collector are
opt-in behind the compose `observability` profile, since they add roughly 512MB-1.5GB of RAM.
See [[openobserve-cloudwatch]] for the collection-pipeline rule and [[ADR-0018-observability-openobserve]]
for why OpenObserve was chosen over SigNoz.

## Steps

### 1. Start the stack

```bash
make observability-up
```

Starts OpenObserve and the OTel collector. UI at http://localhost:5080 once healthy (~5s).

If the containers previously exited with code 128 / `network ... not found`,
`observability-up` now force-recreates them so they re-attach to the current network — see
Gotchas below.

Login (local dev creds only):

- Email: `admin@3mrai.local`
- Password: `Complexpass#123`

### 2. Find your logs

All logs land in a single stream named `logs` in org `default`, combining two sources:

- The compose services' stdout, via the `fluentd` driver into the collector's `fluent_forward`
  receiver.
- The ECS/RDS logs Floci runs, via the collector's `aws_cloudwatch` receiver (e.g.
  `/ecs/3mrai-local-compute-nginx`).

Filter within the stream by container name or CloudWatch log group. Verified live on
2026-07-10: 18 `users` logs (fluentd) and 19 `nginx` logs (aws_cloudwatch) landed and were
queryable in the same stream.

### 3. Stop the stack

```bash
make observability-down
```

This target stops **only** OpenObserve and the collector by naming the two services
explicitly — a bare `docker compose --profile observability stop` would stop the whole
project, not just observability.

## Verification

- `curl -s http://localhost:5080` returns the OpenObserve UI after `make observability-up`.
- A `_search` query (see Gotchas below) returns rows for both the `fluentd` and
  `aws_cloudwatch` sources.
- `make observability-down` leaves the four core services (`users`, `orders`, `tracking`,
  `events-pipeline`) running.

## Dashboards (as code)

Dashboards are version-controlled JSON, not click-ops in the UI. They live in
`observability/dashboards/*.dashboard.json`:

- Per-service: `users.dashboard.json`, `orders.dashboard.json`.
- Cross-service: `overview.dashboard.json`.

The OpenObserve v8 dashboard-schema contract and the import API are documented in
`observability/dashboards/README.md` — read that before hand-editing a dashboard JSON file.

### Import or update

```bash
make observability-dashboards
```

This runs `scripts/import-dashboards.mjs` against the running OpenObserve instance. The script is
**idempotent**: it matches existing dashboards by title and updates them (`PUT` with the
dashboard's hash) instead of creating a duplicate. Verified live: the first run creates each
dashboard, and re-running the same command updates them in place — no duplicates.

### Add or change a panel

1. Edit the relevant dashboard JSON under `observability/dashboards/`.
2. Re-run `make observability-dashboards` to push the change.
3. Verify the panel's underlying query with a `_search` call (see the `doc_num` gotcha below) —
   don't trust the panel rendering alone, and never trust the lagging stream-stats counter.

### Scope

Dashboards are **logs-derived only** — no metrics, no traces (per
[[ADR-0018-observability-openobserve]]). Panels query the `snake_case` structured-log schema now
emitted by the services: `service_name`, `http_route`, `http_response_status_code`, `duration_ms`,
etc. See [[2026-07-16-structured-logging-and-dashboards-design]] for the full schema.

Dashboards currently exist for **`users`** and **`orders`** only — the two services with running
code as of this writing. `tracking` and `events-pipeline` get their dashboards when those services
are built out.

## Gotchas

> [!warning] Stream-stats `doc_num` is unreliable
> OpenObserve's stream-stats API reports `doc_num: 0` even when data is present — it's a
> lagging counter. To check whether data landed, run a `_search` POST instead of the stats
> endpoint:
> ```bash
> NOW_S=$(date +%s); START=$(( (NOW_S-3600)*1000000 )); END=$(( (NOW_S+60)*1000000 ))
> curl -s -u "admin@3mrai.local:Complexpass#123" \
>   -X POST "http://localhost:5080/api/default/_search?type=logs" \
>   -H "Content-Type: application/json" \
>   -d "{\"query\":{\"sql\":\"SELECT * FROM logs\",\"start_time\":${START},\"end_time\":${END},\"size\":10}}"
> ```
> Time bounds are in **microseconds** — use a wide-enough window or a fresh log won't appear
> to be there.

> [!info] CloudWatch logs arrive with up to a minute's delay
> The `aws_cloudwatch` receiver's first poll fires after roughly one `poll_interval` (1m), so
> ECS/RDS logs appear with up to a minute's delay. This is expected, not a bug.

> [!warning] Don't use `docker compose logs` for fluentd-driver containers
> `docker compose logs <svc>` behavior for containers using the `fluentd` log driver varies by
> Docker version. Use OpenObserve to view logs instead of `compose logs`.

> [!warning] Observability containers can strand on a dead Docker network
> Verified live on 2026-07-16: `3mrai-otel-collector-1` and `3mrai-openobserve-1` were found in
> `Exited (128)` state. They had been created ~6 days earlier and stayed attached to a Docker
> network ID that no longer existed — the rest of the compose stack (`users`, `orders`, `floci`,
> DBs) had since been recreated, which recreated the network, but the observability containers
> live outside the main up/down cycle (`observability-down` uses `docker compose stop`, not
> `down`, so they're left stopped rather than removed) and never picked up the new network.
> Restarting them failed with:
> ```
> failed to set up container networking: network <id> not found
> ```
>
> A plain `make observability-up` did **not** fix this on its own — compose reused the stranded
> container instead of recreating it, so it failed again with the same error. The
> `observability-up` target now passes `--force-recreate`, scoped to just the two services, so
> re-running it self-heals by forcing them to re-attach to the current network:
> ```makefile
> $(COMPOSE) --profile observability up -d --force-recreate openobserve otel-collector
> ```
> The scoping matters: an **unscoped** `--force-recreate` bounces the whole app stack (users,
> orders, tracking, events-pipeline, floci all get recreated too) — verified live. Always name
> the two services explicitly.
>
> Manual recovery, if ever needed outside the target:
> ```bash
> docker rm -f 3mrai-otel-collector-1 3mrai-openobserve-1
> make observability-up   # now force-recreates them onto the current network
> ```

## Prod

Deferred. OpenObserve on AWS and the OTLP Basic-auth secret sourced from Secrets Manager (see
[[ADR-0007-secrets-parameter-store]]) are documented but not deployed, so they are unverifiable
against Floci.

## Related

- [[openobserve-cloudwatch]]
- [[ADR-0018-observability-openobserve]]
- [[2026-07-10-openobserve-migration]]
- [[local-dev]]
- [[2026-07-16-structured-logging-and-dashboards-design]]
