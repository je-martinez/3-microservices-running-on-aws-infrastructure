---
title: Local Dev — Ministack
type: runbook
area: infra
status: active
created: 2026-06-26
updated: 2026-06-26
integration-status: n/a
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - ADR-0012-ministack-local
---

# Local Dev — Ministack

## When to run this

Run this runbook when setting up or resetting a local development environment. It covers
spinning up the AWS-local emulation layer (Ministack), starting all microservices in Docker
with live-reload via Docker Watch, and syncing Parameter Store parameters and Secret Manager
secrets to the local stack.

See [[ADR-0012-ministack-local]] for the decision rationale behind Ministack over LocalStack.

## Steps

### 1. Prerequisites

- Docker Desktop running (>= 4.30).
- `nvm use` to activate Node 24.18.0 (see `.nvmrc`).
- AWS CLI configured with a local profile (`aws configure --profile local`).
- Ministack binary installed and on `$PATH`.

### 2. Start Ministack

```bash
ministack up
```

Ministack starts the following local AWS service emulators:

| Service | Local endpoint |
|---|---|
| API Gateway | `http://localhost:4566/restapis` |
| SQS | `http://localhost:4566` |
| Secret Manager | `http://localhost:4566` |
| Parameter Store (SSM) | `http://localhost:4566` |
| S3 | `http://localhost:4566` |

> [!tip]
> Use `ministack status` to confirm all services are healthy before proceeding.

### 3. Sync parameters and secrets

```bash
# Sync Parameter Store entries from the dev seed file
aws ssm put-parameter \
  --endpoint-url http://localhost:4566 \
  --profile local \
  --cli-input-json file://infra/seed/parameters.json

# Sync Secret Manager secrets
aws secretsmanager create-secret \
  --endpoint-url http://localhost:4566 \
  --profile local \
  --cli-input-json file://infra/seed/secrets.json
```

`infra/seed/parameters.json` and `infra/seed/secrets.json` contain non-production placeholder
values. Never commit real credentials to these seed files.

### 4. Start services with Docker Watch

```bash
docker compose up --watch
```

Docker Watch monitors source directories and restarts only the affected container on file
change. Service ports:

| Service | Port |
|---|---|
| users-service | 3001 |
| orders-service | 3002 |
| tracking-service | 3003 |
| events-pipeline | 3004 |

### 5. Verify connectivity

```bash
curl http://localhost:3001/health   # users-service
curl http://localhost:3002/health   # orders-service
curl http://localhost:3003/health   # tracking-service
```

All endpoints should respond with `{"status":"ok"}`.

### 6. Tear down

```bash
docker compose down
ministack down
```

## Verification

- All four `curl /health` calls above return HTTP 200.
- `ministack status` shows all emulators as `running`.
- `docker compose ps` shows all containers as `Up`.
- Logs (`docker compose logs -f <service>`) show no connection errors to SSM or Secret Manager.

## Related

- [[ADR-0012-ministack-local]]
- [[networking]]
- [[aws-resources]]
- [[secret-rotation]]
