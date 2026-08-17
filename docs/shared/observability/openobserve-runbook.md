---
title: OpenObserve — Local Runbook
type: runbook
area: shared
status: active
created: 2026-07-10
updated: 2026-08-16
integration-status: verified
verified-on: 2026-08-16
verified-by: Jose E. Martinez
tags: [type/runbook, area/shared, status/active]
related:
  - "[[openobserve-cloudwatch]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[2026-07-10-openobserve-migration]]"
  - "[[local-dev]]"
  - "[[2026-07-16-structured-logging-and-dashboards-design]]"
  - "[[2026-07-16-structured-logging-and-dashboards]]"
  - "[[2026-07-10-openobserve-migration-design]]"
  - "[[logging-context]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
  - "[[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]]"
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

Starts OpenObserve, **Jaeger** (traces — ADR-0019 routes them there because OpenObserve's own
trace ingest rejected them), and the OTel collector. UI at http://localhost:5080 once healthy
(~5s); Jaeger UI at http://localhost:16686.

The target also **imports the dashboards automatically**: it polls OpenObserve's `/healthz`
first (openobserve declares no compose healthcheck, so `up -d` returns before the container
accepts HTTP) and then runs `make observability-dashboards`. This matters because dashboards
live in the `openobserve-data` volume, which `make clean` deletes (see [[local-dev]]) — before
this, every from-scratch rebuild left OpenObserve running with no dashboards at all.

If the containers previously exited with code 128 / `network ... not found`,
`observability-up` now force-recreates them so they re-attach to the current network — see
Gotchas below.

Login (local dev creds only):

- Email: `admin@3mrai.local`
- Password: `Complexpass#123`

### 2. Find your logs

Logs land in **org `3mrai`** (set as `O2_ORG` in `docker-compose.yml`; the collector ingests
into `/api/3mrai/...`), split across **seven streams**, each fed by its own OTel-collector
pipeline in `observability/otel-collector-config.yaml`. Two receivers feed all of them: the
compose services' stdout via the `fluentd` driver into `fluent_forward`, and the ECS/RDS logs
Floci runs via `aws_cloudwatch` (e.g. `/ecs/3mrai-local-compute-nginx`).

| Stream | Contents |
|---|---|
| `logs` | The application services' own lines — what a dashboard reads by default |
| `sql` | Relational statements: Tracking's SQLAlchemy echo, Orders' EF Core, Users' Prisma |
| `redis` | The ElastiCache/Valkey engine log |
| `docdb` | DocumentDB's engine log AND the events-pipeline's Mongo commands |
| `nginx` | The gateway's access logs |
| `rds` | Both Aurora clusters' engine logs (Users' Postgres, Orders' MySQL) |
| `unclassified` | Catch-all for anything the collector could not attribute to a `service_name` — see below |

Plus the metrics streams — the plain `metrics` stream and the per-metric
`amazonaws_com_3mrai_*` streams (see [[2026-08-12-custom-business-metrics-cloudwatch-design]]).

**Why routed, not dropped.** Each of these five noisy groups (`sql`, `redis`, `docdb`, `nginx`,
`rds`) was split into its **own** stream rather than discarded, because in every case the noisy
group also carries the only signal that matters — an OOM kill, a `MISCONF`, a failed database
start, a request that never reached a service. Dropping the group would create a blind spot
exactly when it counts. Routing costs nothing the old drop rules were buying: the main `logs`
stream stays just as free of the noise, and nothing is lost.

**How the routing works, and the four bugs it is easy to reintroduce.** Every filter above
matches on `resource.attributes["cloudwatch.log.group.name"]` — a **resource** attribute (the
`aws_cloudwatch` receiver puts the log group on the resource, not the log record) with a
**dot-separated** key. Two spellings look plausible and match nothing, silently, under
`error_mode: ignore`:

- A log-record `attributes[...]` lookup instead of `resource.attributes[...]` — always nil.
- The underscored `cloudwatch_log_group_name` spelling OpenObserve's indexer shows in its UI —
  that rename happens downstream of the collector and does not exist at filter time.

Two streams additionally route on a **log-record** attribute rather than (or in addition to) the
log group: `docdb` also matches a `db_statement` attribute (the events-pipeline's Mongo commands,
which arrive from `/aws/lambda/3mrai-local-events` and carry no DocumentDB log group at all), and
`sql` matches `message` (SQLAlchemy's bare statement) or `commandText` (EF Core's wrapped
`DbCommand` line). `db_statement` is deliberately **not** named `commandText` — a record carrying
that name would be claimed by both the `sql` and `docdb` pipelines and stored twice.

**Every `only_*`/`drop_*` filter pair must stay exact complements.** A record matching neither
filter is silently lost; a record matching both is stored twice. Each pair is written from the
same expression for exactly this reason — see the comments beside `filter/only_sql`/
`filter/drop_sql` and their siblings in `observability/otel-collector-config.yaml`.

### The `unclassified` stream — the 7th stream, and it should be empty

**What it is.** A catch-all that receives any log record reaching the end of the collector's
main pipeline missing `service_name` **or** a valid native `severity_number` — i.e. anything
`transform/parse_body` could not parse into the shared schema (see [[logging-context]] for that
schema). It is fed by the same two receivers (`fluent_forward`, `aws_cloudwatch`) as every other
stream and exported by its own pipeline, `logs/unclassified`, to its own
`otlp_http/openobserve_unclassified` exporter.

**The routing criterion is an OR of two independent faults, not one.**

```
filter/drop_unclassified:   'attributes["service_name"] == nil or severity_number == nil or severity_number <= 0'
filter/only_unclassified:   'attributes["service_name"] != nil and severity_number != nil and severity_number > 0'
```

- **No `service_name`** — the parse did not understand the line at all.
- **`severity_number` nil or `<= 0`** — OTel `UNSPECIFIED`. This is **not** "below DEBUG"; it is
  "nobody said." Neither fault implies the other: a record can carry a perfectly good
  `service_name` and still land here — that is exactly what a producer which logs its identity
  but forgets the severity fields looks like. `<= 0` rather than `== 0` so a negative value never
  slips through as classified.

Both filters test the record's **native** `severity_number`, never `attributes["severity_number"]`.
`transform/parse_body`'s final statements copy the parsed severity attribute onto the record's
native field, and the native field is what OpenObserve stores as `severity` and what every
dashboard filters on (see [[logging-context#Severity must reach the record's native fields]]).
Testing the attribute instead would let through a record whose attribute was set but whose copy
to the native field never ran — precisely the half-failure this net exists to catch.

> [!warning] The two filters must stay exact complements — De Morgan, not just mirroring
> With three clauses, the pair is easy to get out of sync: by De Morgan's law, the `or` in
> `filter/drop_unclassified` becomes an `and` of the negations in `filter/only_unclassified`
> (`!= nil` and `> 0`, not `== nil` and `<= 0`). This file's history shows non-complementary
> pairs cause silent data loss (a record matching neither filter) or duplication (a record
> matching both) — see the general complement rule earlier in this note.

**Why it exists.** Before this stream, an unparsed record fell through into the main `logs`
stream with its native `severity` at `0` (OTel `UNSPECIFIED` — **not** "below DEBUG", a distinct
condition dashboards and severity filters don't recognize as anything at all). Such a record was
therefore invisible to every severity-filtered dashboard and every `service_name` query: present,
consuming storage, findable only by a human reading raw data. That exact condition shipped **four
separate times** — nginx startup lines, Valkey/Redis chatter, the tracking codegen scripts'
`print()` output, and CloudWatch-prefixed Lambda records (see
[[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]]) — and a human reading raw data
found every one of them, because nothing surfaced them on its own.

**How to use it operationally.** This stream should normally be **empty**. Rows appearing in it
mean a producer is emitting a shape the collector does not know how to read. When a service's
lines go missing from a dashboard, check `unclassified` first — the raw `body` is preserved
intact, so the unrecognized format can be read directly instead of guessed at. The fix belongs in
the **producer** (emit `service_name` plus `severity_text`/`severity_number` per
[[logging-context]]), never in the collector — patching the collector to recognize one more shape
treats the symptom, and the next new producer reintroduces the same gap.

> [!info] Implementation note — the drop chain is required, not redundant
> `logs/unclassified`'s processor chain repeats every `filter/drop_*` from the main `logs`
> pipeline (`drop_nginx`, `drop_redis`, `drop_docdb`, `drop_rds`, `drop_sql`) before applying
> `filter/only_unclassified`. Every other split is defined by a log group or attribute it
> **owns**; "unclassified" is defined by **absence** — no `service_name` — so without those same
> drops it would swallow legitimately-unparsed records that belong to the other streams instead
> (a DocumentDB or RDS engine line whose body is plain text also has no `service_name`, but it
> is not unclassified — it's `docdb`/`rds` traffic that just happens not to be JSON).

> [!warning] Querying `unclassified` requires `SELECT *`, never a named column list
> OpenObserve infers a stream's schema from the data it has actually ingested. A stream with no
> rows yet has no schema, so naming a column (`SELECT service_name, body FROM unclassified`)
> fails the **entire** query with `"No field named service_name"`. Always query with
> `SELECT * FROM unclassified` (see the `_search` example in Gotchas below, swapping the stream
> name).
>
> A related trap when scripting a check against this stream: `_search` against a stream that has
> **never been written to** returns HTTP **400** with error code **20002**
> (`"Search stream not found"`) — not a 404. Code-matching on `20002` is how
> `e2e/tests/observability/unclassified-logs.spec.ts` distinguishes "empty and healthy" (stream
> exists, or has never needed to exist, either way zero rows) from a real query error.

### 3. Stop the stack

```bash
make observability-down
```

This target stops **only** OpenObserve, Jaeger, and the collector by naming the three services
explicitly — a bare `docker compose --profile observability stop` would stop the whole
project, not just observability.

## Verification

- `curl -s http://localhost:5080` returns the OpenObserve UI after `make observability-up`.
- A `_search` query against org `3mrai` (see Gotchas below) returns rows for both the `fluentd`
  and `aws_cloudwatch` sources.
- `make observability-down` leaves the four core services (`users`, `orders`, `tracking`,
  `events-pipeline`) running.

## Dashboards (as code)

Dashboards are version-controlled JSON, not click-ops in the UI. They live in
`observability/dashboards/*.dashboard.json`:

- Per-service: `users.dashboard.json`, `orders.dashboard.json`,
  `tracking.dashboard.json`, `events-pipeline.dashboard.json`.
- Cross-service: `overview.dashboard.json`.
- CloudWatch-sourced business metrics: `business-metrics.dashboard.json`.

They are imported automatically by `make observability-up` — the dashboards live
in the `openobserve-data` volume, which `make clean` deletes, and nothing
recreated them before, so every from-scratch rebuild left OpenObserve running
with none. The importer keys on dashboard TITLE and PUTs when one already
exists, so re-running it is a no-op rather than a duplicate.

`e2e/tests/observability/dashboards.spec.ts` asserts that every field these
panels query still exists in its stream, so a renamed or dropped field fails CI
instead of silently emptying a panel.

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

Dashboards query both signals now: the `snake_case` structured-`logs` schema (`service_name`,
`http_route`, `http_response_status_code`, `duration_ms`, etc. — see
[[2026-07-16-structured-logging-and-dashboards-design]]) and, since
[[2026-08-12-custom-business-metrics-cloudwatch-design]], the per-metric
`amazonaws_com_3mrai_*` streams via PromQL (see the gotcha on query type below). Traces stay out
of OpenObserve — they go to Jaeger (see [[ADR-0019-distributed-tracing-opentelemetry]]).

Dashboards exist per service — `users.dashboard.json`, `orders.dashboard.json`,
`tracking.dashboard.json`, `events-pipeline.dashboard.json` — plus `overview.dashboard.json`
(cross-service) and `business-metrics.dashboard.json` (the CloudWatch-sourced metrics above).

## Gotchas

> [!warning] Stream-stats `doc_num` is unreliable
> OpenObserve's stream-stats API reports `doc_num: 0` even when data is present — it's a
> lagging counter. To check whether data landed, run a `_search` POST instead of the stats
> endpoint:
> ```bash
> NOW_S=$(date +%s); START=$(( (NOW_S-3600)*1000000 )); END=$(( (NOW_S+60)*1000000 ))
> curl -s -u "admin@3mrai.local:Complexpass#123" \
>   -X POST "http://localhost:5080/api/3mrai/_search?type=logs" \
>   -H "Content-Type: application/json" \
>   -d "{\"query\":{\"sql\":\"SELECT * FROM logs\",\"start_time\":${START},\"end_time\":${END},\"size\":10}}"
> ```
> Org is `3mrai`, not `default` — swap `type=logs`/`FROM logs` for one of the other six stream
> names (`sql`, `redis`, `docdb`, `nginx`, `rds`, `unclassified`) to check those. Time bounds are
> in **microseconds** — use a wide-enough window or a fresh log won't appear to be there. For
> `unclassified` specifically, use `SELECT *` — see the stream's own section above for why a
> named column list fails the whole query.

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
> `observability-up` target now passes `--force-recreate`, scoped to just the observability
> services, so re-running it self-heals by forcing them to re-attach to the current network:
> ```makefile
> $(COMPOSE) --profile observability up -d --force-recreate openobserve jaeger otel-collector
> ```
> The scoping matters: an **unscoped** `--force-recreate` bounces the whole app stack (users,
> orders, tracking, events-pipeline, floci all get recreated too) — verified live. Always name
> the services explicitly. `jaeger` must be named too, and its earlier absence from this list
> (it sat only in `profiles: [observability]`, in no target) was the entire reason traces went
> nowhere — a profile alone does not start a service.
>
> Manual recovery, if ever needed outside the target:
> ```bash
> docker rm -f 3mrai-otel-collector-1 3mrai-openobserve-1 3mrai-jaeger-1
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
- [[2026-07-16-structured-logging-and-dashboards]] — the implementation plan for the dashboards this runbook documents.
- [[2026-07-10-openobserve-migration-design]] — the design spec for the OpenObserve backend this runbook operates.
- [[logging-context]] — the shared context fields the `logs`/`sql`/`docdb` streams' records carry.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the metrics pipeline and streams referenced above.
- [[ADR-0019-distributed-tracing-opentelemetry]] — why traces go to Jaeger, not OpenObserve.
- [[2026-08-16-cloudwatch-lambda-log-prefix-defeats-json-parse]] — one of the four recurring
  causes of records landing unclassified: the Lambda CloudWatch prefix defeating the JSON parse.
