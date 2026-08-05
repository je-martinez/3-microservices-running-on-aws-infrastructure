---
name: floci
description: Use when working with Floci, the local AWS emulator (single port :4566) the 3MRAI repo uses for local dev — Terraform/SDKs targeting AWS_ENDPOINT_URL, ECS/Cognito/API Gateway/Lambda/EventBridge locally, or debugging local-emulator quirks. Knowledge layer: per-service doc links + 3MRAI-verified quirks and workarounds.
metadata:
  area: infra
  source: docs/lessons/floci-vs-ministack-spike-findings.md
  verified: 2026-06-29
---

# Floci — local AWS emulator (knowledge layer)

[Floci](https://floci.io/floci/) is an MIT-licensed local AWS emulator (65 services on a
single port `:4566`, same `AWS_ENDPOINT_URL` interface as the SDKs/CLI). The 3MRAI repo
evaluated it as a Ministack replacement in a spike. This skill is a **navigable knowledge
layer**: per-service links to the official docs (`references/services.md`) plus the
**quirks verified empirically in 3MRAI** — so infra work targets Floci correctly without
re-discovering its gotchas.

**This skill does not replace the official docs.** When you need depth on a service, open
its page from `references/services.md`. When you hit a behavior that differs from real AWS,
check the "Verified quirks" below first.

## When to use

- Writing/validating Terraform or SDK code that targets the local emulator (`:4566`).
- Configuring ECS, Cognito, API Gateway v2, Lambda, EventBridge, networking locally.
- Debugging "works in AWS, breaks locally" issues — the quirks below are the usual cause.

## Base setup

Same env interface as Ministack / LocalStack:

```bash
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
```

- Image: `floci/floci:latest` (Quarkus app; ships `curl`). `latest-compat` pre-wires
  AWS CLI/boto3 creds + endpoint for init-hook scripts.
- In 3MRAI it runs as the `floci` service in the root `docker-compose.yml`. Bring the
  whole local chain up with `make bootstrap` (floci → terraform apply → regenerate
  `.env` → start `users` → `bootstrap.sh`); `docker compose up -d floci` starts the
  emulator alone.

### Config env vars worth knowing

- `FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network` — ECS tasks launch as real
  Docker containers joined to this compose network (so they resolve compose services by
  `container_name` via Docker DNS). **Required** for the local reverse-proxy pattern.
- `FLOCI_STORAGE_MODE` ∈ `memory|persistent|hybrid|wal`; `FLOCI_STORAGE_PERSISTENT_PATH`.
- `FLOCI_SERVICES_ECS_MOCK=true` — skip Docker, tasks go straight to RUNNING (CI/tests).
- Init hooks: scripts under `/etc/floci/init/{boot,start,ready,stop}.d/` run at lifecycle
  phases (`ready.d/` after APIs are up — good for seeding). See
  [initialization-hooks](https://floci.io/floci/configuration/initialization-hooks/).

## Verified quirks in 3MRAI (read before debugging)

Source of truth with full evidence: [[floci-vs-ministack-spike-findings]]
(`docs/lessons/floci-vs-ministack-spike-findings.md`).

1. **AWS provider must be pinned to `= 5.31.0`.** Provider v5.100 fails
   `aws_cognito_user_pool_client` apply with *"Provider produced inconsistent result"*.
2. **`aws_cognito_user_pool_client` returns empty computed blocks.** Floci returns
   `AnalyticsConfiguration: {}` (and `RefreshTokenRotation: {}`), which the provider reads
   as "block present" and aborts apply. Workaround:
   `lifecycle { ignore_changes = [analytics_configuration] }`. The client is created &
   functional regardless.
3. **Separate SG-rule resources WORK** (`aws_vpc_security_group_ingress_rule` /
   `egress_rule`) — no inline-rule workaround needed (this Ministack quirk is gone).
4. **API Gateway v2 local invoke URL is LocalStack-style**, NOT `<id>.execute-api.localhost:4566`
   (that path hits Floci's S3 handler → `NoSuchBucket`). Use:
   `http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>`.
5. **Cognito `iss` claim is Floci's own endpoint:** `http://localhost:4566/<pool-id>`
   (not `https://cognito-idp.<region>.amazonaws.com/<pool-id>`). The JWT authorizer
   `issuer` must match this exactly or every token → 401.
6. **Route53 / Cloud Map do NOT back DNS resolution.** Floci's Route53 is
   *management-plane only* ("actual DNS resolution is not provided"); ECS tasks are not
   registered in Cloud Map. For container-to-container resolution use **Docker's native
   networking** (resolve by `container_name`, or attach a constant network alias).
7. **Cognito Lambda triggers: it depends WHICH trigger — the split is the whole point.**
   - **Sign-up/lifecycle triggers are stored but NEVER invoked** (PostConfirmation,
     PreSignUp, etc.) — same as Ministack. To capture user data on sign-up, **emit a
     domain event from your service** (`events:PutEvents`) → EventBridge → target.
     **EventBridge DOES deliver to Lambda/SQS targets in Floci** (verified).
   - **The three `CUSTOM_AUTH` challenge triggers ARE genuinely invoked** (verified
     2026-08-05): `DefineAuthChallenge`, `CreateAuthChallenge`,
     `VerifyAuthChallengeResponse`. `InitiateAuth --auth-flow CUSTOM_AUTH` returns
     `ChallengeName: CUSTOM_CHALLENGE` and echoes back the Lambda's own
     `publicChallengeParameters`; `RespondToAuthChallenge` issues real tokens on the
     right answer and `NotAuthorizedException: Incorrect challenge answer` on a wrong
     one. A user created with **no password at all** completes the flow. They also
     coexist with a `PreTokenGenerationConfig` V2 trigger without breaking its claim.
     Floci even validates the wiring: with the triggers absent, `CUSTOM_AUTH` fails
     with `InvalidUserPoolConfigurationException: DefineAuthChallenge trigger is not
     configured`. So **email-OTP login is implementable locally** — via `CUSTOM_AUTH`.
   - **⚠️ TRAP — native `USER_AUTH` / `EMAIL_OTP` silently bypasses authentication.**
     `InitiateAuth --auth-flow USER_AUTH` with `PREFERRED_CHALLENGE=EMAIL_OTP` is
     ACCEPTED and **returns tokens with no challenge whatsoever** — the parameter is
     ignored, not rejected. A test written against native `EMAIL_OTP` passes green
     while auth is entirely skipped. Use `CUSTOM_AUTH`, never native `EMAIL_OTP`, and
     always assert that a WRONG code is rejected.
8. **ECS task is recreated on every `terraform apply`** (new container name + IP). Don't
   pin the integration to a discovered IP. Use a **stable Docker-DNS alias** (e.g.
   `nginx-stable`) attached after apply; the API GW integration stays fixed at
   `http://nginx-stable/` — no `docker inspect`, no patch. See `bootstrap.sh`
   (`infra/environments/local/`).
9. **A second `terraform apply` FAILS.** Floci's `UpdateTags` breaks for API GW v2 stages
   (`NotFoundException: Invalid API id`) and RDS clusters (`DBInstanceNotFound`). Only a
   from-scratch apply works. To re-apply: `docker compose down && rm -rf data/floci &&
   rm -f infra/environments/local/terraform.tfstate* && make bootstrap`. See
   [[floci-rds-apigw-limits]].
10. **`FLOCI_STORAGE_MODE=persistent`, never `hybrid`.** Floci's README recommends `hybrid`
    for local dev, but its 5s async flush loses writes on an unclean stop (measured:
    write → SIGKILL@0.5s → restart; `persistent` and `wal` survive, `hybrid` does not).
    Floci can also leave a **truncated `.tmp`** state file, which it then silently ignores
    at boot — the symptom is "state vanished" with no log line. Check `ls data/floci/*.tmp`.
    See [[floci-storage-modes-and-tmp-corruption]].
11. **Postgres is reached at `floci:7001`** (Floci's RDS proxy), not at `:4566` and never by
    container IP — Floci reassigns those on every recreation. Writer and reader endpoints
    are identical locally: no read-replica emulation. **Caveat:** the proxy port is NOT
    deterministic — Floci assigns 7000–7099 by cluster **creation order**, so postgres/mysql
    can flip between 7001/7002 (verified). Discover per-engine via
    `aws rds describe-db-clusters` (`infra/environments/local/scripts/discover_db_port.py`).
12. **SQS → Lambda → DocumentDB all really work** (verified 2026-08-03, Floci v1.5.28) —
    full evidence in [[floci-sqs-lambda-docdb-support]]. **Every limitation below is
    local-only and does NOT constrain the production design.**
    - Works like real AWS: SQS visibility timeout, `ApproximateReceiveCount`, **automatic
      DLQ redrive**, real batching in the event source mapping, and **partial batch
      responses** (`batchItemFailures` retries only the failed record).
    - **`update-event-source-mapping` silently drops `FunctionResponseTypes`** (returns
      `[]`); `create` persists it. To add `ReportBatchItemFailures` to an existing mapping,
      **recreate it** — updating looks like it worked and silently retries whole batches.
    - **DocumentDB is a standalone `mongo:7.0`, no replica set** → no multi-document
      transactions locally. Real Amazon DocumentDB supports them (engine 4.0+); single-doc
      writes are atomic either way. Fails even with `retryWrites=false` — don't chase that flag.
    - **DocumentDB is not discovered like RDS:** absent from `rds describe-db-clusters`, and
      27017 is **not** published to the host. `aws docdb describe-db-clusters` returns a Docker
      network IP that changes on recreation — connect by the backing container name
      **`floci-docdb-<db-cluster-identifier>`** via Docker DNS instead.

## Per-service knowledge

See [references/services.md](references/services.md) — every Floci service with its
official doc URL, marked for what 3MRAI uses, plus troubleshooting notes where the service
page has them.

## Authoritative links

- Overview: https://floci.io/floci/
- Configuration / env vars: https://floci.io/floci/configuration/environment-variables/
- Services index: https://floci.io/floci/services/
- Init hooks: https://floci.io/floci/configuration/initialization-hooks/
- The 3MRAI local environment (working reference impl): `infra/environments/local/`
