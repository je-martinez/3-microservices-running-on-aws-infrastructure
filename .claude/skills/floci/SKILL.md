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

**This skill does not replace the official docs — <https://floci.io/floci/services/> is the
source of truth.** `references/services.md` is a generated `<service → URL>` map of all 70
services on that index; use it to open the right page instead of guessing a slug (a
plausible URL that 404s is worse than no link). If a service is missing from the map, open
the index and check — do not invent the slug. When you hit a behavior that differs from real
AWS, check the "Verified quirks" below first.

**Before concluding a service is unsupported, read its page — including its own Docker
Compose section.** ElastiCache was written off here as "returns an unreachable endpoint"
until that section turned out to document a proxy port range this repo had simply never
published. The emulator was fine; the compose file was incomplete (quirk 14).

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
13. **CloudFront is management-plane only** (verified 2026-08-06) — same shape as the Route53
    quirk above. `create-distribution` succeeds with a real Id/ARN/`DomainName` and
    `Status: "Deployed"`, but the returned `<id>.cloudfront.net` domain does not resolve and
    serves nothing (`curl` → HTTP code `000`). `delete-distribution` also refuses with
    `DistributionNotDisabled` unless disabled first. S3 as an origin works fully
    (`mb`/`cp`/`GET` all return real objects) — the gap is CloudFront's edge/serving layer
    specifically. Terraform apply state alone cannot tell you a CDN-fronted asset is
    unreachable locally; only curling the domain does.
    [Floci's own docs](https://floci.io/floci/services/cloudfront/) state it outright:
    *"Actual content delivery is not emulated — this is a management-plane-only
    implementation."* They also note there is **no local invoke URL** for a distribution
    (unlike API Gateway's `/restapis/...`), so there is nothing to point a template at.
    See [[floci-vs-ministack-spike-findings]].

14. **ElastiCache Redis works for real — but the Terraform provider crashes on it, and the
    endpoint it reports is a lie** (verified 2026-08-09). Unlike CloudFront and Route53, this
    is *not* management-plane only: Floci launches a genuine **`valkey/valkey:8`** container
    named **`floci-valkey-<replication-group-id>`**, joined to the compose network, and it
    answers real commands — `PING`→`PONG`, `SET k v EX 600`→`OK`, `GET`→value, `TTL`→`600`.
    **Native key expiry works**, which is what makes it usable for short-lived data
    (the Users password-reset codes). Four traps, all measured:
    - **It must be a REPLICATION GROUP, not a cache cluster.**
      `create-cache-cluster --engine redis` is rejected outright: *"Engine must be 'memcached'.
      For Redis/Valkey use CreateReplicationGroup."* In Terraform that means
      `aws_elasticache_replication_group`, never `aws_elasticache_cluster`.
    - **⚠️ The pinned AWS provider `5.31.0` CRASHES against it, after creating the resource.**
      `panic: runtime error: index out of range [0] with length 0` at
      `internal/service/elasticache/replication_group.go:632` — the provider reads
      `NodeGroups[0]` to populate `primary_endpoint_address`, and Floci's response carries only
      `ConfigurationEndpoint`, no `NodeGroups`. This is worse than a plain error: **the group IS
      created before the panic but nothing lands in state**, so the retry fails with
      `ReplicationGroupAlreadyExistsFault` and the root is wedged. Locally the repo drives it
      through the established **awscli-fallback** pattern instead (`infra/modules/redis/`),
      keeping the native resource for real AWS.
    - **The reported `localhost:6379` endpoint is REAL — but only if you publish the proxy port
      range.** Floci proxies TCP to the backing container over
      `FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT`–`_MAX_PORT` (**6379-6399** by default), the
      same arrangement as the RDS range in quirk 11. **This repo originally published
      `7000-7010` but not `6379-6399`**, so the port was simply closed and the endpoint looked
      like a lie — a configuration gap on our side, not an emulator limitation. Publishing the
      range on the `floci` service makes the endpoint answer from the host (verified:
      `PING`→`PONG`, `SET … EX 600`, `TTL`→`600`).
      **3MRAI moves the range to `6479-6499`, off Floci's default**, because 6379 is Redis's
      well-known port and collides with any local Redis a developer runs — whoever binds first
      wins, and the loser either refuses to start ("port is already allocated") or, far worse,
      a client silently reaches the WRONG Redis. Overriding it takes BOTH the published ports
      **and** `FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT` / `_MAX_PORT`; set only one and you
      get a closed port with no error anywhere. Verified with a developer's own Redis on 6379
      running at the same time: Floci served 6479, and neither instance could see the other's
      keys.
      **Read the service page's own Docker Compose section before concluding a service is
      broken** — this was found by doing exactly that, after the wrong conclusion had already
      been written down.
      In-network containers do not need the published range: they reach
      `floci-valkey-<replication-group-id>:6379` directly by Docker DNS. Unlike the RDS proxy
      ports (quirk 11), that hostname **is** deterministic — we choose the replication group id
      — so it can be written into an env file rather than discovered.
    - **There is no ElastiCache subnet-group API.** `CreateCacheSubnetGroup` /
      `DescribeCacheSubnetGroups` both return `UnsupportedOperation`, and unlike rds/docdb there
      is no `default` group to point at — create the group without one.

15. **Floci-spawned containers are NOT grouped under the compose project in Docker UIs —
    cosmetic, and there is no fix** (checked 2026-08-09). Docker Desktop/OrbStack group by the
    `com.docker.compose.project` label, and Floci creates its containers through the Docker API
    without it (`docker inspect floci-valkey-… -f '{{index .Config.Labels "com.docker.compose.project"}}'`
    → empty, against `3mrai` for a compose service). So the ~13 `floci-*` containers — RDS,
    DocumentDB, Valkey, the ECS nginx task, every Lambda — appear loose beside the project group
    rather than inside it.
    **Nothing is actually wrong:** they still join `3mrai_3mrai-network` and resolve by name, which
    is what the stack depends on. Do not read the flat listing as a broken stack.
    Two dead ends, both verified rather than assumed: Floci exposes **no env var for container
    labels** (its environment-variables page documents `FLOCI_DOCKER_*` for socket, registry, log
    rotation and a resource namespace, plus `FLOCI_SERVICES_*_DOCKER_NETWORK` — none for labels),
    and **Docker labels are immutable after create** (`docker update` has no `--label`), so they
    cannot be patched on afterwards. Recreating the containers to add labels would lose DB state
    and detach them from the Floci that owns them — not worth a grouping box.

16. **⚠️ RECREATING the floci container DESTROYS its backing containers, and the API keeps
    reporting them `available`** (verified 2026-08-09). `docker compose up -d floci` — which
    recreates the container after any compose edit — takes the RDS, DocumentDB and ElastiCache
    containers down with it. `docker compose stop floci && docker compose start floci` does
    **not**: the same three survived a stop/start intact. So the trigger is RECREATION, not
    restart.
    This is by design, not a bug: Floci documents `KEEP_RUNNING_ON_SHUTDOWN` for OpenSearch, ECR
    and EKS — and **offers no such setting for RDS, DocumentDB or ElastiCache**.
    **The dangerous part is the lying state.** `describe-replication-groups` /
    `describe-db-clusters` still answer `Status: available` for a resource whose container no
    longer exists; nothing surfaces the gap until a service dials it and gets
    `getaddrinfo ENOTFOUND floci-docdb-…`. Never trust `available` after touching the floci
    container — check `docker ps` for the backing container.
    Recovery is uneven, so know which you are dealing with:
    - **Lambdas** relaunch themselves on the next invocation. But they come back from the zip
      Terraform deployed, silently discarding any later `update-function-code` — the symptom is
      a handler reverting to `"reason":"Unknown event type"`.
    - **ElastiCache** recovers by deleting and recreating the replication group with the SAME id
      (the id is ours, so `REDIS_HOST` stays valid).
    - **DocumentDB can WEDGE.** The cluster survives in state without a container, and
      `delete-db-cluster` refuses with `InvalidDBClusterStateFault: it still has DB instances`
      while those instances have no backing container either. At that point a from-scratch
      `make clean && make bootstrap` is cheaper than unpicking it.
    **Practical rule: after editing the `floci` service in docker-compose.yml, plan on a full
    `make bootstrap`** — do not assume an `up -d` is a cheap in-place change.

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
