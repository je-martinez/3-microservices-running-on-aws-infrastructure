---
title: "OpenObserve backend migration — Implementation Plan"
type: plan
area: shared
status: draft
created: 2026-07-10
updated: 2026-07-10
tags: [type/plan, area/shared, status/draft]
related: ["[[2026-07-10-openobserve-migration-design]]", "[[ADR-0018-observability-openobserve]]", "[[2026-07-10-signoz-logs-observability]]", "[[openobserve-cloudwatch]]", "[[ADR-0007-secrets-parameter-store]]"]
---

# OpenObserve Backend Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocked SigNoz backend with a self-hosted OpenObserve, by adding one container and repointing the collector's exporter — the log-capture pipeline (collector receivers + the services' fluentd logging) is unchanged.

**Architecture:** A single `openobserve` container joins the compose `observability` profile. The existing OTel collector's exporter changes from `otlp`→SigNoz to `otlp_http`→OpenObserve (Basic auth + stream-name). Logs from both receivers (fluent_forward, aws_cloudwatch) land in one OpenObserve stream, queryable in its UI.

**Tech Stack:** docker-compose, OpenObserve v0.91.1 (single Rust binary), otel-collector-contrib 0.156.0, Floci, Makefile.

## Global Constraints

- Verification is LIVE integration, not unit tests (infra — same as the Floci chain).
- ZERO service source-code changes and ZERO changes to the collector's RECEIVERS or the four services' fluentd logging blocks (SigNoz plan Tasks 1-2, already committed). Only the collector's EXPORTER, a new compose service, and the Makefile change.
- OpenObserve image PINNED to `public.ecr.aws/zinclabs/openobserve:v0.91.1` — never `:latest`.
- Use the exporter alias `otlp_http`, NOT the deprecated `otlphttp` (the collector logs a deprecation warning for the old name).
- The exporter endpoint is `http://openobserve:5080/api/default` with headers `Authorization: "Basic ${env:O2_BASIC_AUTH}"` and `stream-name: logs`. `O2_BASIC_AUTH` is base64 of `email:password`, set in the collector's compose env from the same ZO_ROOT_USER creds.
- OpenObserve + collector sit behind `profiles: [observability]`; `make up`/`make bootstrap` do NOT start them; `make observability-up` does.
- **Verify data presence with a direct `_search` POST** (`SELECT * FROM logs` with `start_time`/`end_time` in MICROSECONDS), NOT the stream-stats `doc_num` — that counter lags and reads 0 even when data is present (verified).
- OpenObserve needs ~512MB-1.5GB RAM (one container; far lighter than the retired SigNoz stack).

---

### Task 1: Add the OpenObserve service + repoint the collector's exporter

**Files:**
- Modify: `docker-compose.yml` (add `openobserve` service; change the `otel-collector` env from SIGNOZ_OTLP_ENDPOINT to O2_BASIC_AUTH)
- Modify: `observability/otel-collector-config.yaml` (exporter otlp→otlp_http/openobserve)

**Interfaces:**
- Consumes: the collector's existing receivers (fluent_forward :24224, aws_cloudwatch) — unchanged.
- Produces: a running `openobserve` on :5080 that the collector exports OTLP-HTTP to; logs land in the `logs` stream of org `default`.

**Decision (stream layout):** a SINGLE stream named `logs`. Both sources (fluentd service logs, aws_cloudwatch ECS/RDS logs) go to it. OpenObserve filters within a stream by resource attributes (service.name, cloudwatch.log.group.name), so one stream is enough and simplest; separate streams are a later refinement if query volume warrants.

- [ ] **Step 1: Add the OpenObserve service to docker-compose.yml**

Add this service right after the existing `otel-collector` service block (which ends at its `depends_on: floci: condition: service_healthy`):

```yaml
  # OpenObserve: single-binary logs backend (ADR-0018). Behind the observability
  # profile like the collector. Pinned image; do not use :latest. Local dev creds
  # only — prod reads them from Secrets Manager (ADR-0007).
  openobserve:
    image: public.ecr.aws/zinclabs/openobserve:v0.91.1
    profiles: [observability]
    environment:
      - ZO_ROOT_USER_EMAIL=admin@3mrai.local
      - ZO_ROOT_USER_PASSWORD=Complexpass#123
    ports:
      - "5080:5080"   # UI + OTLP HTTP ingest
    volumes:
      - ./data/openobserve:/data
    networks: [3mrai-network]
```

- [ ] **Step 2: Repoint the collector's exporter env in docker-compose.yml**

In the `otel-collector` service's `environment:` list, REMOVE the line
`- SIGNOZ_OTLP_ENDPOINT=signoz-otel-collector:4317`
and ADD:
```yaml
      # base64("admin@3mrai.local:Complexpass#123") — the OpenObserve Basic auth
      # header value. Local dev only; prod injects this from Secrets Manager.
      - O2_BASIC_AUTH=YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz
```
Also update the `otel-collector` comment above the service (currently says "exported to self-hosted SigNoz") to say "exported to self-hosted OpenObserve".

Note: the base64 value `YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz` is exactly `base64("admin@3mrai.local:Complexpass#123")` — verify with `printf 'admin@3mrai.local:Complexpass#123' | base64` (must match, no trailing newline).

- [ ] **Step 3: Change the exporter in observability/otel-collector-config.yaml**

Replace the current `exporters:` block:
```yaml
exporters:
  # SigNoz's own OTel collector ingests OTLP (wired in Task 3). insecure: local only.
  otlp:
    endpoint: ${env:SIGNOZ_OTLP_ENDPOINT}
    tls:
      insecure: true
```
with:
```yaml
exporters:
  # OpenObserve OTLP-HTTP ingest (ADR-0018). Use otlp_http — the otlphttp alias
  # is deprecated. Basic auth + stream-name are what OpenObserve requires.
  otlp_http/openobserve:
    endpoint: http://openobserve:5080/api/default
    headers:
      Authorization: "Basic ${env:O2_BASIC_AUTH}"
      stream-name: logs
```
And in the `service.pipelines.logs` block, change `exporters: [otlp]` to `exporters: [otlp_http/openobserve]`.

- [ ] **Step 4: Verify compose parses and the profile still gates**

Run:
```bash
docker compose config -q && echo "compose OK"
docker compose --profile observability config --services | grep -E "openobserve|otel-collector"
docker compose config --services | grep -E "openobserve|otel-collector" || echo "correctly absent without the profile"
```
Expected: compose parses; both `openobserve` and `otel-collector` appear WITH the profile; NEITHER appears without it.

- [ ] **Step 5: Verify base64 auth value is correct**

Run: `printf 'admin@3mrai.local:Complexpass#123' | base64`
Expected: `YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz` (exactly the value in the compose env — if it differs, the header is wrong and ingest will 401).

---

### Task 2: Makefile targets for the observability stack

**Files:**
- Modify: `Makefile` (add `observability-up` / `observability-down` targets + .PHONY)

**Interfaces:**
- Consumes: the `observability` profile services from Task 1.
- Produces: `make observability-up` (starts OpenObserve + collector) and `make observability-down` (stops just them).

- [ ] **Step 1: Add the targets**

In `Makefile`, after the `clean:` target (the last one), add:

```makefile
observability-up: ## Start OpenObserve + the OTel collector (opt-in; ~512MB-1.5GB RAM)
	$(COMPOSE) --profile observability up -d
	@echo "OpenObserve UI on http://localhost:5080 once it's healthy (~5s)."
	@echo "Login: admin@3mrai.local / Complexpass#123"

observability-down: ## Stop the observability stack (leaves the rest running)
	$(COMPOSE) --profile observability stop
```

- [ ] **Step 2: Add them to .PHONY**

Change the `.PHONY:` line (currently ends `... migrate bootstrap clean`) to append the two new targets:
```makefile
.PHONY: help up down logs build ps infra-init infra-plan infra-up infra-down infra-output env-file migrate bootstrap clean observability-up observability-down
```

- [ ] **Step 3: Verify the targets exist and use `stop` not `down`**

Run:
```bash
make help | grep observability
grep -A2 "^observability-down:" Makefile | grep -E "stop|down"
```
Expected: both targets listed in help; `observability-down` uses `--profile observability stop` (NOT a bare `down`, which would tear down the whole project including floci/users).

---

### Task 3: End-to-end live verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1-2 plus the base stack.
- Produces: proof the whole log path works to OpenObserve.

- [ ] **Step 1: Bring up the full stack from a clean slate**

Run:
```bash
docker compose down && rm -rf data/floci data/openobserve && mkdir -p data/floci
find infra/environments/local -maxdepth 1 -name 'terraform.tfstate*' -delete
rm -f infra/environments/local/.app-db-secret .env
make bootstrap
make observability-up
```
Expected: `make bootstrap` exits 0 (floci + users + migrations up); `make observability-up` starts OpenObserve + collector.

- [ ] **Step 2: Confirm OpenObserve is healthy**

Run:
```bash
for i in $(seq 1 15); do curl -sf -o /dev/null http://localhost:5080/healthz && break; sleep 2; done
curl -s -o /dev/null -w 'openobserve healthz → %{http_code}\n' http://localhost:5080/healthz
```
Expected: `200`.

- [ ] **Step 3: Generate a users log and confirm it's queryable in OpenObserve (the fluentd path)**

The `users` service logs via the fluentd driver → collector fluent_forward → OpenObserve. Generate a line and search for it:
```bash
curl -s -o /dev/null http://localhost:3000/v1/health   # produces a users request log
sleep 8
NOW_S=$(date +%s); START=$(( (NOW_S - 3600) * 1000000 )); END=$(( (NOW_S + 60) * 1000000 ))
curl -s -u "admin@3mrai.local:Complexpass#123" \
  -X POST "http://localhost:5080/api/default/_search?type=logs" \
  -H "Content-Type: application/json" \
  -d "{\"query\":{\"sql\":\"SELECT * FROM logs\",\"start_time\":${START},\"end_time\":${END},\"size\":10}}"
```
Expected: a JSON response with a non-empty `hits` array containing recent log lines. (Do NOT judge by the stream-stats `doc_num` — it lags; the `_search` hits are the truth.)

- [ ] **Step 4: Confirm the aws_cloudwatch path still surfaces nginx ECS logs**

nginx runs as an ECS task in Floci → /ecs/ log group → aws_cloudwatch receiver → OpenObserve. Wait a poll cycle (poll_interval 1m) and search for the nginx access line:
```bash
bash infra/environments/local/bootstrap.sh >/dev/null 2>&1 || true   # ensure nginx is proxying
sleep 95   # first aws_cloudwatch poll fires after ~1 interval
NOW_S=$(date +%s); START=$(( (NOW_S - 86400) * 1000000 )); END=$(( (NOW_S + 60) * 1000000 ))
curl -s -u "admin@3mrai.local:Complexpass#123" \
  -X POST "http://localhost:5080/api/default/_search?type=logs" \
  -H "Content-Type: application/json" \
  -d "{\"query\":{\"sql\":\"SELECT * FROM logs WHERE match_all('nginx')\",\"start_time\":${START},\"end_time\":${END},\"size\":10}}"
```
Expected: hits including nginx lines (e.g. a `GET /v1/health HTTP/1.1 200` access log or an nginx `[notice]` startup line), proving the second receiver reaches OpenObserve alongside fluentd. (If `match_all` syntax errors on this OpenObserve version, drop the WHERE clause and eyeball the hits for nginx content.)

- [ ] **Step 5: Confirm the safety property — services still start without the observability profile**

Run:
```bash
make observability-down
docker compose up -d --build users
curl -s http://localhost:3000/v1/health
```
Expected: `{"status":"ok"}` — with OpenObserve and the collector down, users still boots and serves (fluentd-async, from Task 2 of the SigNoz plan). This proves the heavy stack stays optional.

---

## Follow-ups (not this plan)

- **OTel traces/metrics instrumentation** of the services — a later phase (ADR-0018 accepts OpenObserve's weaker APM for now; re-evaluate if distributed tracing becomes a hard requirement).
- **Prod deployment**: Terraform to run OpenObserve on AWS + the OTLP Basic-auth secret from Secrets Manager (ADR-0007) — documented, deployed later, unverifiable against Floci.
- **Vault runbook note** for `make observability-up` (OpenObserve UI at :5080, login, one `logs` stream) — routed to obsidian-vault after this plan lands.

## Related

- [[2026-07-10-openobserve-migration-design]]
- [[ADR-0018-observability-openobserve]]
- [[2026-07-10-signoz-logs-observability]]
- [[openobserve-cloudwatch]]
- [[ADR-0007-secrets-parameter-store]]
