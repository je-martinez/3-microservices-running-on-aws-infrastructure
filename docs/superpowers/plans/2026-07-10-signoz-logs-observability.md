---
title: "SigNoz log observability via CloudWatch + fluentd — Implementation Plan"
type: plan
area: shared
status: draft
created: 2026-07-10
updated: 2026-07-10
tags: [type/plan, area/shared, status/draft]
related: ["[[2026-07-10-signoz-logs-observability-design]]", "[[ADR-0011-observability-signoz]]", "[[openobserve-cloudwatch]]", "[[ADR-0017-floci-local]]", "[[local-dev]]", "[[2026-07-10-openobserve-migration-design]]"]
---

# SigNoz Log Observability Implementation Plan

> [!warning] Tasks 1-2 done and committed; Task 3 is BLOCKED
> Task 1 (collector) and Task 2 (fluentd routing on the four services) are implemented and
> committed. Task 3 (self-hosted SigNoz) is **blocked** on a schema-migrator hang — diagnosis
> and resume options in [[signoz-selfhost-migrator-blocker]]. Task 4 (end-to-end UI
> verification) depends on Task 3 and is also unimplemented until it unblocks. The backend was
> superseded by OpenObserve — see [[2026-07-10-openobserve-migration-design]] and
> [[ADR-0018-observability-openobserve]].

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture logs from all local services into a self-hosted SigNoz, via an OpenTelemetry collector fed by two sources — Docker's fluentd driver (compose services) and the aws_cloudwatch receiver (ECS/RDS on Floci) — with zero service-code changes.

**Architecture:** A pinned `otel/opentelemetry-collector-contrib` runs two receivers (`fluent_forward` :24224, `aws_cloudwatch` polling Floci) into one logs pipeline that OTLP-exports to a self-hosted SigNoz (ClickHouse + query-service + UI). The collector and SigNoz live behind a compose `profile: [observability]` so the heavy stack is opt-in; the four services carry a `fluentd` log-driver block always, made safe by `fluentd-async` so they start whether or not the collector is up.

**Tech Stack:** docker-compose, otel-collector-contrib 0.156.0, SigNoz self-hosted (vendored compose pinned at `v0.90.1`, ClickHouse `24.1.2-alpine`), Floci (local CloudWatch), Makefile.

## Global Constraints

- Verification is LIVE integration, not unit tests (this is infra — same as the Floci chain work).
- ZERO service source-code changes. Only `docker-compose.yml`, collector config, SigNoz compose fragment, and the `Makefile`.
- Collector image PINNED to `otel/opentelemetry-collector-contrib:0.156.0` — never `:latest`.
- Receiver aliases are `aws_cloudwatch` and `fluent_forward`. The old `awscloudwatch`/`fluentforward` are DEPRECATED — do not use them.
- `fluentd-address` MUST be `localhost:24224` — the Docker daemon resolves it from the HOST, not the compose network. A compose service name will fail with `no such host`.
- Every service's fluentd logging block MUST set `fluentd-async: "true"` (string) — without it, a service fails to start when the collector isn't running (verified: `connection refused` at container init). With it, the service starts `exit 0` regardless.
- `aws_cloudwatch` receiver reaches Floci via `AWS_ENDPOINT_URL=http://floci:4566` + creds `test`/`test` (verified working). It polls only the `/ecs/` prefix.
- SigNoz + collector go behind `profiles: [observability]`. `make bootstrap` / `make up` must NOT start them; a new `make observability-up` does.
- Do NOT propose the Docker `awslogs` driver (forces EC2 IMDS on Mac, fails) or the `filelog` receiver (sees nothing on Docker Desktop for Mac). Both were verified broken.
- SigNoz needs ≥4GB RAM allocated to Docker.

---

### Task 1: Vendor the OTel collector config and add the collector service (observability profile)

**Files:**
- Create: `observability/otel-collector-config.yaml`
- Modify: `docker-compose.yml` (add the `otel-collector` service under the observability profile)

**Interfaces:**
- Consumes: Floci's CloudWatch on the `3mrai-network` (`http://floci:4566`).
- Produces: a collector listening on `:24224` (fluent_forward) and polling `/ecs/`, exporting OTLP to `${SIGNOZ_OTLP_ENDPOINT}` (wired to SigNoz in Task 3). Until Task 3, the OTLP export target won't exist — that's expected; this task verifies the two RECEIVERS ingest, using a `debug` exporter temporarily is NOT needed because Task 3 supplies the real target; instead this task verifies via the collector's own logs that both receivers start and the aws_cloudwatch receiver reaches Floci.

- [ ] **Step 1: Write the collector config**

Create `observability/otel-collector-config.yaml`:

```yaml
# OpenTelemetry Collector config for 3MRAI log observability.
# Two receivers feed one logs pipeline exported to self-hosted SigNoz.
#   - fluent_forward: the compose services' stdout, via Docker's fluentd driver.
#   - aws_cloudwatch: ECS/RDS logs Floci runs (e.g. the nginx ECS task).
# Env-parameterized so the same file serves local (Floci) and, later, prod.
receivers:
  # Docker fluentd driver → here. The services set fluentd-address=localhost:24224
  # (the daemon resolves it from the host, hence the published port).
  fluent_forward:
    endpoint: 0.0.0.0:24224
  # Polls CloudWatch. AWS_ENDPOINT_URL redirects it to Floci locally.
  aws_cloudwatch:
    region: ${env:AWS_REGION}
    logs:
      poll_interval: 1m
      groups:
        autodiscover:
          limit: 50
          prefix: /ecs/

processors:
  batch: {}

exporters:
  # SigNoz's own OTel collector ingests OTLP (wired in Task 3). insecure: local only.
  otlp:
    endpoint: ${env:SIGNOZ_OTLP_ENDPOINT}
    tls:
      insecure: true

service:
  telemetry:
    logs:
      level: info
  pipelines:
    logs:
      receivers: [fluent_forward, aws_cloudwatch]
      processors: [batch]
      exporters: [otlp]
```

- [ ] **Step 2: Add the collector service to docker-compose.yml**

Add this service (place it after the `floci` service, before the app services):

```yaml
  # ── Observability (opt-in): `docker compose --profile observability up` ──
  # OTel collector: fluentd from the compose services + CloudWatch (ECS/RDS) on
  # Floci, exported to self-hosted SigNoz. Pinned image; do not use :latest.
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.156.0
    profiles: [observability]
    command: ["--config=/etc/otelcol-contrib/config.yaml"]
    ports:
      - "24224:24224"   # fluent_forward — published so the Docker daemon (host) can reach it
    environment:
      - AWS_ENDPOINT_URL=http://floci:4566
      - AWS_REGION=us-east-1
      - AWS_ACCESS_KEY_ID=test
      - AWS_SECRET_ACCESS_KEY=test
      - SIGNOZ_OTLP_ENDPOINT=signoz-otel-collector:4317
    volumes:
      - ./observability/otel-collector-config.yaml:/etc/otelcol-contrib/config.yaml:ro
    networks: [3mrai-network]
    depends_on:
      floci:
        condition: service_healthy
```

- [ ] **Step 3: Verify both receivers start and aws_cloudwatch reaches Floci**

The SigNoz target doesn't exist yet (Task 3), so the otlp EXPORTER will error on send — that's expected and does not stop the receivers. Start just the collector and read its logs:

Run:
```bash
docker compose --profile observability up -d otel-collector
sleep 95
docker compose logs otel-collector | grep -iE "Everything is ready|fluent_forward|aws_cloudwatch|Starting"
docker compose logs floci --since 25s | grep -iE "DescribeLogGroups|FilterLogEvents"
```
Expected: the collector logs `Everything is ready`, and Floci logs `DescribeLogGroups` + `FilterLogEvents` (proving the aws_cloudwatch receiver reached Floci). The collector will also log otlp export errors (no SigNoz yet) — that is expected at this task. The first aws_cloudwatch poll fires after roughly one poll_interval (1m), so the DescribeLogGroups/FilterLogEvents calls appear at ~90s, not immediately — do not conclude the receiver is broken before then. (Verified: the receiver reaches Floci and emits real /ecs/ nginx LogRecords; the earlier delay is just the poll cadence.) At info level the received records aren't printed (only the otlp export retries are), so "no visible log bodies" here does NOT mean the receiver failed — the Floci-side DescribeLogGroups/FilterLogEvents calls are the proof it works. The full log body path is proven end-to-end in Task 4 once SigNoz exists.

- [ ] **Step 4: Tear the collector back down**

Run: `docker compose --profile observability stop otel-collector`
Expected: clean stop. Leave the work in the working tree for the main session to commit.

---

### Task 2: Route the four services' logs through the fluentd driver

**Files:**
- Modify: `docker-compose.yml` (add a `logging:` block to `users`, `orders`, `tracking`, `events-pipeline`)

**Interfaces:**
- Consumes: the collector's `fluent_forward` receiver on `localhost:24224` (Task 1).
- Produces: each service's stdout is delivered to the collector when it's up, and the service starts normally when it isn't (via `fluentd-async`).

- [ ] **Step 1: Add the logging block to each of the four services**

To EACH of `users`, `orders`, `tracking`, `events-pipeline` in `docker-compose.yml`, add a `logging:` block at the same indent level as the service's `environment:`. Use the service's own name as the tag. For `users`:

```yaml
    # stdout → the observability collector's fluent_forward receiver.
    # localhost:24224 because the Docker daemon resolves fluentd-address from the
    # HOST, not this network. fluentd-async so the service still starts when the
    # observability profile (and thus the collector) is not running.
    logging:
      driver: fluentd
      options:
        fluentd-address: "localhost:24224"
        fluentd-async: "true"
        tag: "users"
```

Repeat for `orders` (tag `orders`), `tracking` (tag `tracking`), `events-pipeline` (tag `events-pipeline`) — identical except the `tag` value.

- [ ] **Step 2: Verify services still start WITHOUT the observability profile**

This is the critical safety property — services must not depend on the collector to boot.

Run:
```bash
docker compose up -d --build users
sleep 8
curl -s http://localhost:3000/v1/health
```
Expected: `{"status":"ok"}` — `users` starts and serves even though no collector is running (fluentd-async absorbs the missing target).

- [ ] **Step 3: Confirm the driver is actually fluentd**

Run: `docker inspect 3mrai-users-1 --format '{{.HostConfig.LogConfig.Type}}'`
Expected: `fluentd` (was `json-file` before).

Note a consequence: with the fluentd driver, `docker compose logs users` no longer shows this container's logs (they go to the driver, not json-file). That's expected — logs are now viewed in SigNoz. If a developer needs raw stdout without SigNoz, they can temporarily comment the `logging:` block. Document this in Task 4's runbook note.

---

### Task 3: Add the self-hosted SigNoz stack (observability profile)

**Files:**
- Create: `observability/signoz/` (vendored SigNoz compose fragment + its config files)
- Modify: `docker-compose.yml` (include/reference the SigNoz services under the observability profile) OR add them inline — decide in Step 1.

**Interfaces:**
- Consumes: OTLP from `otel-collector` (Task 1) at `signoz-otel-collector:4317`.
- Produces: the SigNoz UI on a host port (exact port confirmed from the vendored compose — see Step 1), backed by ClickHouse + query-service.

- [ ] **Step 1: Vendor the SigNoz self-hosted compose**

SigNoz's self-hosted compose that we vendor is `deploy/docker/docker-compose.yaml` in the SigNoz
repo, pinned at tag **`v0.90.1`**. Later SigNoz tags dropped the self-host compose path entirely in
favor of their "Foundry" CLI — `deploy/docker/clickhouse-setup/` no longer exists on any tag, and
`v0.131.0` has no compose under `deploy/docker/` at all. `v0.90.1` is the last tag confirmed to ship
a usable `deploy/docker/docker-compose.yaml` (196 lines) — that is our pinned self-host reference.
Fetch that tag's compose and its accompanying config (otel-collector config, ClickHouse config)
into `observability/signoz/`.

Run (to obtain the exact files):
```bash
# Pinned tag: v0.90.1 (last tag with deploy/docker/docker-compose.yaml).
# Place the compose + config under observability/signoz/. Do NOT use `develop`
# or a later tag — they dropped the self-host compose for the Foundry CLI.
```
Bring the SigNoz services under the `observability` profile — every SigNoz service gets `profiles: [observability]` so it starts only with `--profile observability`, and joins `3mrai-network` so our `otel-collector` can reach `signoz-otel-collector:4317`. The real service list to bring under the profile, per the v0.90.1 compose: `clickhouse`, `zookeeper`, `signoz` (unified UI + query-service), `signoz-otel-collector`, and the two schema-migrator services (`signoz-schema-migrator-sync` / `signoz-schema-migrator-async`, or however the vendored compose names the sync/async pair).

Note the pinned image versions the v0.90.1 compose actually ships (vendor these, don't substitute newer ones without re-verifying): `clickhouse/clickhouse-server:24.1.2-alpine`, `bitnami/zookeeper:3.7.1`, `signoz/signoz:v0.90.1`, `signoz/signoz-otel-collector:v0.128.2`, `signoz/signoz-schema-migrator:v0.128.2`.

The UI service `signoz` in the v0.90.1 compose publishes port 8080 (verified); the Makefile note and the verification step below use http://localhost:8080.

CRITICAL: SigNoz ships its OWN otel-collector (named `signoz-otel-collector`, image `signoz/signoz-otel-collector:v0.128.2` per the v0.90.1 compose). Do NOT confuse it with OUR `otel-collector` (Task 1). Ours RECEIVES app/CloudWatch logs and forwards OTLP to SigNoz's collector, which writes to ClickHouse. Our `SIGNOZ_OTLP_ENDPOINT=signoz-otel-collector:4317` must match SigNoz's collector service name on the network — confirmed by the v0.90.1 compose, which names that service `signoz-otel-collector`.

- [ ] **Step 2: Bring up the full observability stack**

Run:
```bash
docker compose --profile observability up -d
# ClickHouse takes ~30-60s to become healthy on first boot.
sleep 60
docker compose --profile observability ps
```
Expected: `otel-collector`, `signoz-otel-collector`, ClickHouse, query-service, and the SigNoz UI all `Up`/healthy.

- [ ] **Step 3: Verify our collector now exports to SigNoz without error**

Run:
```bash
docker compose logs otel-collector --since 30s | grep -iE "error|otlp|refused" | tail -5
```
Expected: NO otlp export errors (contrast Task 1, where SigNoz didn't exist yet). Absence of `connection refused`/export errors means the OTLP hop to SigNoz works.

---

### Task 4: End-to-end verification and the Makefile/runbook wiring

**Files:**
- Modify: `Makefile` (add `observability-up` / `observability-down` targets)
- Create: a short runbook note is handled by obsidian-vault, not here — this task only wires the Makefile and does the live E2E proof.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: `make observability-up` / `make observability-down`, and a proven end-to-end log path.

- [ ] **Step 1: Add Makefile targets**

In `Makefile`, after the existing compose targets, add:

```makefile
observability-up: ## Start SigNoz + the OTel collector (heavy: needs ~4GB RAM)
	$(COMPOSE) --profile observability up -d
	@echo "SigNoz UI will be on http://localhost:8080 once ClickHouse is healthy (~60s)."

observability-down: ## Stop the observability stack (leaves the rest running)
	$(COMPOSE) --profile observability stop
```
Add `observability-up observability-down` to the `.PHONY` line.

- [ ] **Step 2: Prove the fluentd path end-to-end (the user's core ask)**

With the full stack up (`make bootstrap` then `make observability-up`, users rebuilt with the fluentd driver from Task 2):

Run:
```bash
# generate a log line in users
curl -s -o /dev/null http://localhost:3000/v1/health
sleep 5
# confirm OUR collector received it via fluent_forward (temporarily add a debug
# exporter, OR query SigNoz). Simplest live check: tail the collector and look
# for the users container tag arriving.
docker compose logs otel-collector --since 20s | grep -iE "users|fluent" | head -5
```
Expected: evidence of the `users`-tagged log passing through the collector. Then open the SigNoz UI (`http://localhost:8080`) → Logs, filter by the `users` tag/container, and confirm the `/v1/health` line is queryable. Paste what you see.

- [ ] **Step 3: Prove the aws_cloudwatch path still surfaces ECS logs**

Run:
```bash
# nginx runs as an ECS task in Floci → /ecs/ log group → aws_cloudwatch receiver.
# Hit the health endpoint through nginx to generate an access log, wait a poll cycle.
bash infra/environments/local/bootstrap.sh >/dev/null 2>&1 || true
sleep 70   # poll_interval is 1m
```
Then in the SigNoz UI, filter logs for the nginx access line (`GET /v1/health`). Expected: the ECS nginx log is queryable in SigNoz, proving the second receiver works alongside fluentd.

- [ ] **Step 4: Confirm the safety property one more time, cleanly**

Run:
```bash
make observability-down
docker compose up -d --build users
curl -s http://localhost:3000/v1/health
```
Expected: `{"status":"ok"}` — with observability DOWN, users still starts and serves (fluentd-async). This is the guarantee that the heavy stack stays optional.

---

## Follow-ups (not this plan)

- **OTel traces/metrics instrumentation** of the services (direct OTLP SDKs) — a later phase; three services are still empty scaffolds.
- **Prod deployment**: Terraform to run the collector on ECS in real AWS, plus the IAM policy (`logs:DescribeLogGroups`, `logs:FilterLogEvents`). Documented in the spec, deployed later — unverifiable against Floci (no IAM enforcement), the same boundary JE-36 accepted.
- **Vault runbook note** for `make observability-up` and the "docker compose logs no longer shows fluentd-driver containers" gotcha — routed to obsidian-vault after this plan lands.

## Related

- [[2026-07-10-signoz-logs-observability-design]]
- [[ADR-0011-observability-signoz]]
- [[openobserve-cloudwatch]]
- [[ADR-0017-floci-local]]
- [[local-dev]]
- [[2026-07-10-openobserve-migration-design]]
