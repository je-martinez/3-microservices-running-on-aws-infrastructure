---
title: "SigNoz log observability via CloudWatch + fluentd — Design"
type: spec
area: shared
status: draft
created: 2026-07-10
updated: 2026-07-10
tags: [type/spec, area/shared, status/draft]
related: ["[[ADR-0011-observability-signoz]]", "[[openobserve-cloudwatch]]", "[[ADR-0017-floci-local]]", "[[local-dev]]", "[[floci-rds-apigw-limits]]", "[[2026-07-10-openobserve-migration-design]]"]
---

# SigNoz log observability via CloudWatch + fluentd — Design

## Problem / scope

[[ADR-0011-observability-signoz]] decided "logs and traces via CloudWatch → SigNoz" and
[[openobserve-cloudwatch]] (then `signoz-cloudwatch`) records the convention, but both are
high-level — neither specifies a concrete mechanism. This spec designs the **logs-only**
implementation. Traces/metrics via direct OTel instrumentation are a later phase: three of the
four services (`orders`, `tracking`, `events-pipeline`) are still empty scaffolds, so there is
little to instrument yet.

> [!warning] SigNoz backend superseded by OpenObserve
> The SigNoz backend designed below (Components → "SigNoz self-hosted") turned out to be blocked
> (see [[signoz-selfhost-migrator-blocker]]) and was superseded by OpenObserve — see
> [[2026-07-10-openobserve-migration-design]] and [[ADR-0018-observability-openobserve]]. The
> log-capture design here (receivers, fluentd routing) is unaffected and remains accurate.

**Scope:** capture logs from all local services and forward them to a self-hosted SigNoz, with
**zero changes to service source code** — infra and docker-compose only.

Prod (real AWS/ECS) is **designed** here but **deployment** (Terraform for the collector on ECS +
its IAM policy) is a follow-up: [[floci-rds-apigw-limits]] already established that Floci doesn't
validate IAM and the ECS task lifecycle is unreliable across re-applies, so the collector's prod
deployment can't be verified against Floci — the same "verifiable-on-Floci-only" scope boundary
[[floci-rds-apigw-limits]] (JE-36) accepted for infra work.

## Architecture

Two log sources converge on one OpenTelemetry Collector, which exports OTLP to a self-hosted
SigNoz.

```
LOCAL (docker-compose):
  users, orders, tracking, events-pipeline (compose containers, json-file by default)
      │  logging.driver: fluentd  → host localhost:24224
      ▼
  otel-collector-contrib
      ├─ receiver: fluent_forward (:24224)   ← logs from the compose services
      └─ receiver: aws_cloudwatch            ← logs from ECS tasks / RDS that Floci runs (nginx, etc.)
      │  OTLP
      ▼
  SigNoz self-hosted (ClickHouse + query-service + UI)  ← UI on localhost

PROD (AWS):
  services run on ECS → awslogs driver → CloudWatch
      ▼
  collector (aws_cloudwatch receiver only) → SigNoz
```

The collector is the **same binary** in both environments; which receivers are active differs by
environment (local: both `aws_cloudwatch` and `fluent_forward`; prod: `aws_cloudwatch` only, since
prod services log to CloudWatch natively via the ECS `awslogs` driver and there is no fluentd
path).

## Verified facts

These were confirmed **live today (2026-07-10)** against the running Floci stack and the real
`otel/opentelemetry-collector-contrib` image; they are recorded here as established, not
re-derived or hedged as untested.

1. **Floci CloudWatch supports the receiver's API calls.** `aws logs describe-log-groups` returns
   real groups (`/ecs/3mrai-local-compute`, `/ecs/3mrai-local-compute-nginx`,
   `/aws/rds/instance/.../error`), and `filter-log-events` returns real event bodies.
2. **The `aws_cloudwatch` receiver works against Floci via `AWS_ENDPOINT_URL`.** Ran
   `otel/opentelemetry-collector-contrib:0.156.0` with `AWS_ENDPOINT_URL=http://floci:4566` plus
   credentials `test`/`test`; Floci logged `DescribeLogGroups` and `FilterLogEvents`, and the
   collector's debug exporter emitted real nginx access logs (`GET /v1/health HTTP/1.1 200`).
   > [!note] A closed-as-not-planned OTel issue is outdated
   > OTel issue #38219 claimed the receiver couldn't target LocalStack without a code patch —
   > that claim is **outdated**; it works today via `AWS_ENDPOINT_URL`. Recorded here so nobody
   > re-chases the dead issue.
3. **The receiver alias `awscloudwatch` is deprecated → use `aws_cloudwatch`.** Same for
   `fluentforward` → `fluent_forward`. The collector logs both deprecation warnings; use the
   current names in all config.
4. **Local compose containers do NOT reach Floci CloudWatch.** `users` runs with Docker's default
   `json-file` driver; there is no `users` log group in Floci — its logs only appear via `docker
   compose logs users`. The `aws_cloudwatch` receiver alone cannot see the four services locally.
   This is the gap the fluentd path closes.
5. **The Docker `fluentd` log-driver → collector `fluent_forward` receiver works on macOS.** A
   container run with `--log-driver=fluentd --log-opt fluentd-address=localhost:24224` delivered
   its stdout to the collector, which emitted the line with full metadata (`container_id`,
   `container_name`, `source: stdout`, `fluent.tag`).
   > [!warning] `fluentd-address` is resolved by the Docker daemon from the host
   > Not from the compose network. It must be `localhost:24224` (the collector's **published**
   > port), **not** the compose service name. A `fluentd-address=fluentcol:24224` attempt failed
   > with `no such host`.
6. **Two "zero-code" alternatives were tested and fail on macOS** — recorded here so they aren't
   re-attempted:
   - **Docker `awslogs` log-driver pointed at Floci** fails at container start — it tries EC2 IMDS
     for credentials and ignores passed env creds (`no EC2 IMDS role found ... context deadline
     exceeded`).
   - **`filelog` receiver reading `/var/lib/docker/containers/*/*.log`** sees 0 records on Docker
     Desktop for Mac — that path lives inside the Docker VM and isn't reliably mountable. It would
     work on a Linux host/CI, but not local Mac dev.
   - The collector ships **no** Docker-API log receiver (`docker_stats` is metrics-only).

## Components

- **`otel-collector-contrib`** — `otel/opentelemetry-collector-contrib:0.156.0`. **Pin the
  version, not `:latest`** (fact 3's deprecated aliases are a reminder that receiver names shift
  between versions). New compose service. Depends on: no Docker socket access is needed; it needs
  its config file mounted, the published port `24224` (`fluent_forward`), and
  `AWS_ENDPOINT_URL`/credentials for the `aws_cloudwatch` receiver against Floci. The config is
  parameterized by environment variables so the same file serves local and prod.
- **SigNoz self-hosted** — ClickHouse + query-service + frontend, from SigNoz's official compose.
  New services; consider a compose `profile` so the heavy ClickHouse stack is opt-in (flag the RAM
  cost — see [Open questions](#open-questions-for-the-plan)). The collector's `otlp` exporter
  targets SigNoz's OTLP endpoint on the compose network.
- **docker-compose `logging:` blocks** — each of the four services (`users`, `orders`, `tracking`,
  `events-pipeline`) gets:
  ```yaml
  logging:
    driver: fluentd
    options:
      fluentd-address: localhost:24224
      tag: <service>
  ```
  This is compose config, **not** service source code — the zero-source-change constraint holds.
  **Startup ordering:** if a service starts before the collector's `24224` is listening, the
  fluentd driver fails to initialize and the service container won't start. The collector must be
  up first — via `depends_on` and/or the driver's `fluentd-async` option (see [Error
  handling](#error-handling-edge-cases)).

## Collector config (illustrative — the plan will finalize)

```yaml
receivers:
  aws_cloudwatch:
    region: ${AWS_REGION}
    logs:
      poll_interval: 1m
      groups:
        autodiscover: { limit: 50, prefix: /ecs/ }
  fluent_forward:
    endpoint: 0.0.0.0:24224
exporters:
  otlp:
    endpoint: ${SIGNOZ_OTLP_ENDPOINT}
    tls: { insecure: true } # local; prod tightens
processors:
  batch: {}
service:
  pipelines:
    logs:
      receivers: [aws_cloudwatch, fluent_forward]
      processors: [batch]
      exporters: [otlp]
```

Both receiver names use the current (non-deprecated) form per fact 3. In prod, the `pipelines.logs
.receivers` list drops to `[aws_cloudwatch]` since there is no fluentd source there.

## Error handling / edge cases

- **Collector not up when a service starts** → fluentd driver init fails → the service container
  won't start. Mitigate with compose startup ordering (`depends_on`) and/or the fluentd driver's
  `fluentd-async` option. Stated explicitly so it isn't mistaken for a service bug during local
  bring-up.
- **SigNoz down** → the collector can't export. Per [[ADR-0011-observability-signoz]], SigNoz
  availability is **not** required for services to function. The fluentd driver's buffering and
  the collector's own queue absorb short outages; a long outage drops logs — acceptable, since
  CloudWatch remains the authoritative log store in prod.
- **`aws_cloudwatch` `poll_interval` (1m)** means local ECS/RDS logs appear with up to a minute of
  delay. Noted so it isn't mistaken for a bug during verification.

## Testing strategy

This is infra; verification is live integration, not unit tests — the same approach
[[floci-rds-apigw-limits]] used for the Terraform chain. From a running stack: generate traffic
(e.g. `curl` against `users`' `/v1/health`), then confirm (a) the line reaches the collector via
`fluent_forward`, and (b) it's queryable in the SigNoz UI. Separately confirm the `aws_cloudwatch`
path still surfaces the nginx ECS logs. The implementation plan will spell out the exact commands.

## In scope / Out of scope

**In scope:** the `otel-collector-contrib` compose service and its config; the SigNoz self-hosted
compose services; `logging: fluentd` blocks on the four services; environment wiring
(`AWS_ENDPOINT_URL`, `SIGNOZ_OTLP_ENDPOINT`, `AWS_REGION`); live verification per [Testing
strategy](#testing-strategy).

**Out of scope (follow-ups):**
- OTel traces/metrics instrumentation of the services.
- Terraform to deploy the collector on ECS in real AWS, plus its IAM policy
  (`logs:DescribeLogGroups`, `logs:FilterLogEvents`) — documented here, deployed later, per
  [Problem / scope](#problem-scope).
- A compose `profile` decision if SigNoz should not run always-on locally.

## Open questions for the plan

- SigNoz always-on vs. a compose `profile: [observability]` (RAM cost of ClickHouse).
- Exact SigNoz self-hosted compose version/pinning to vendor in.
- Whether to route the `aws_cloudwatch` receiver at both `/ecs/` and `/aws/rds/` prefixes, or just
  `/ecs/`.

## Related

- [[ADR-0011-observability-signoz]]
- [[openobserve-cloudwatch]]
- [[ADR-0017-floci-local]]
- [[local-dev]]
- [[floci-rds-apigw-limits]]
- [[2026-07-10-openobserve-migration-design]]
