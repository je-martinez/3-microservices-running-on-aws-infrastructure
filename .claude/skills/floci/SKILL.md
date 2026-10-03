---
name: floci
description: 'Use when working with Floci, the local AWS emulator (single port :4566) the 3MRAI repo uses for local dev — Terraform/SDKs targeting AWS_ENDPOINT_URL, ECS/Cognito/API Gateway/Lambda/EventBridge locally, or debugging local-emulator quirks. Knowledge layer: per-service doc links + 3MRAI-verified quirks and workarounds.'
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

- Image: pinned `floci/floci:2.1.0` (Quarkus app). The standard image has bash and
  coreutils but **no `curl`** — a healthcheck must use bash `/dev/tcp` (see quirk 19).
  `latest-compat` pre-wires AWS CLI/boto3 creds + endpoint for init-hook scripts.
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
   registered in Cloud Map (re-verified on 2.1.0). For container-to-container resolution use **Docker's native
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
9. **A second `terraform apply` SUCCEEDS on 2.1.0, but never prints `No changes.`** The
   `UpdateTags` failures (`NotFoundException: Invalid API id` on API GW v2 stages,
   `DBInstanceNotFound` on RDS clusters) do not reproduce: two consecutive applies on a
   fresh stack both end `Apply complete! Resources: 0 added, 8 changed, 0 destroyed.`
   The 8 are perpetual in-place drift that Floci's describe responses cause: the three WS
   `aws_apigatewayv2_integration.fn` (`content_handling_strategy`), `aws_cognito_user_pool`
   (reads back without `lambda_config`/`username_configuration`, yet the pool keeps its
   triggers), the ECS service (`propagate_tags`) and task definition (tags), and both RDS
   clusters. A from-scratch apply is still the reproducible path (`make clean && make
   bootstrap`; `clean` runs `docker compose down -v`, destroying the `floci-state` volume
   with the containers — see quirk 17). See [[floci-rds-apigw-limits]].
10. **`FLOCI_STORAGE_MODE=persistent`, never `hybrid`.** Floci's README recommends `hybrid`
    for local dev, but its 5s async flush loses writes on an unclean stop (measured:
    write → SIGKILL@0.5s → restart; `persistent` and `wal` survive, `hybrid` does not).
    Floci can also leave a **truncated `.tmp`** state file, which it then silently ignores
    at boot — the symptom is "state vanished" with no log line. Check with
    `docker compose exec floci ls /app/data | grep '\.tmp$'` (the state lives in the
    `floci-state` volume now, not under `./data`).
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
    Still true on 2.1.0 (re-verified): delivery is absent, and Floci's docs describe a
    nightly-build track for CloudFront rather than a release. See [[floci-vs-ministack-spike-findings]].

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
    Patching labels on is a dead end: **Docker labels are immutable after create** (`docker
    update` has no `--label`), and recreating the containers to add them would lose DB state and
    detach them from the Floci that owns them — not worth a grouping box.
    Floci 2.1.0's docs list **`FLOCI_DOCKER_EXTRA_LABELS_N__KEY` / `_VALUE`** for labelling the
    containers it spawns. Untested in 3MRAI: setting them is the only candidate fix, and it
    applies to containers created after the setting, not existing ones.

16. **⚠️ On 2.1.0 a plain `docker compose stop floci` DESTROYS DocumentDB and ElastiCache
    containers, and the API keeps reporting them `available`** (re-verified on 2.1.0).
    Floci's graceful SIGTERM shutdown deletes its DocumentDB and Valkey containers and never
    relaunches them, so stop/start, a Docker restart and `up -d` recreation all end the same
    way: a resource `Status: available` whose container is gone, noticed only when a service
    dials it and gets `getaddrinfo ENOTFOUND floci-docdb-…`. Floci documents
    `KEEP_RUNNING_ON_SHUTDOWN` for OpenSearch, ECR and EKS — **not for RDS, DocumentDB or
    ElastiCache**. Never trust `available` after touching the floci container: check `docker ps`.
    **The fix is two parts, both in the repo:**
    - **`stop_signal: SIGKILL`** on the `floci` service. A killed Floci skips the shutdown that
      deletes the containers, so they keep their data. Safe only with
      `FLOCI_STORAGE_MODE=persistent` (quirk 10): SIGKILL gives no flush.
    - **`make heal`** after any Floci or Docker restart (quirk 22).
    Recovery is uneven by service:
    - **Lambdas** relaunch on the next invocation, from the zip Terraform deployed, silently
      discarding any later `update-function-code` — the symptom is a handler reverting to
      `"reason":"Unknown event type"`.
    - **RDS** containers are relaunched by Floci from persisted state at boot. DocumentDB and
      ElastiCache have no such reconciler; `make heal` restarts the exited containers.
    - **The ECS reconciler is lazy:** it relaunches the nginx task only once something touches
      the ECS API, so a healed stack with no ECS call has no gateway. `make heal` makes that call.
    - **Delete + recreate no longer wedges** on 2.1.0: deleting a DocumentDB cluster or a
      replication group whose container is gone succeeds, so a phantom is recoverable without a
      full rebuild (quirk 17 has the sequence).

17. **⚠️ Floci's persisted state must die WITH its containers, or a from-scratch rebuild
    silently half-works** (verified 2026-08-10 — the general case behind quirk 16). Any
    teardown that removes the backing containers while KEEPING the emulator state produces
    phantom resources: Floci boots, loads the state, and answers `available` for clusters
    whose containers no longer exist. `terraform apply` then asks "does it exist?", is told
    yes, and **creates nothing** — reporting success. Nothing fails until a service dials the
    resource and gets `getaddrinfo ENOTFOUND floci-docdb-…`.
    - **It is selective, which is what makes it look intermittent.** Floci relaunches RDS
      containers from persisted state at boot (`RdsContainerManager` logs
      *"Starting RDS backend container for instance…"*). **DocumentDB and ElastiCache have no
      such reconciler** — they load state and launch nothing. So one `make clean &&
      make bootstrap` leaves Postgres/MySQL healthy and DocumentDB/ElastiCache phantom.
    - **A bind mount cannot be cleared by compose.** `docker compose down -v` removes named
      volumes but never bind mounts, so state under `./data` outlives every teardown. 3MRAI
      moved Floci's state to the **`floci-state` named volume** for exactly this reason, and
      `make clean` runs `down -v` unconditionally: a prompt that defaults to KEEPING the
      state makes rebuilds non-deterministic.
    - **Recovery without a full rebuild**, if a phantom is already there: delete the resource
      through its own API (`aws docdb delete-db-cluster --skip-final-snapshot`,
      `aws elasticache delete-replication-group`), then `terraform taint` the module's
      `terraform_data.*_via_cli` resource and re-apply that target. A plain `-target` apply
      does **nothing** — the awscli-fallback resources only re-run when their trigger changes.
    - **`make doctor` cross-checks this**, and classifies each backing container as running,
      exited (healable by `make heal`) or missing (needs the recovery above): every declared DocumentDB/ElastiCache resource
      against `docker ps`, failing loudly instead of leaving it to surface at runtime.
    - **Do not read DocumentDB's cluster list from `aws docdb describe-db-clusters`** — it
      returns the RDS clusters (mysql, postgres) and omits the DocumentDB one entirely, so it
      yields both false phantoms and a missed real one. The generated `DOCDB_HOST` **is** the
      container name; check that instead.

18. **API GW v2 `request_parameters` work on 2.1.0, and log/ECR details differ from AWS**
    (verified 2.1.0).
    - `overwrite:header.<h> = $context.authorizer.claims.sub` on an integration behind a JWT
      authorizer injects the claim as a header, and `overwrite:path` rewrites the path.
    - On a **public route (no authorizer)** the same `overwrite:header.x-user-id =
      $context.authorizer.claims.sub` leaves a client-sent `x-user-id` INTACT — the context
      value is empty, so nothing overwrites it. `remove:header.x-user-id` strips it. Public
      routes must `remove:`, never rely on `overwrite:`, or a client can spoof the identity header.
    - The ECS `awslogs-group` option is ignored: logs land in `/ecs/<task-family>`.
    - ECR repository URIs always carry `:4566`, whatever port the registry is reached on.

19. **The image answers `GET / HTTP/1.0` (no `Host`) with HTTP 500.** A healthcheck must send
    HTTP/1.1 with a `Host` header against `/_floci/health`. The 2.x image has no `curl`, so the
    compose healthcheck speaks HTTP over bash `/dev/tcp` (`docker-compose.yml`, `floci` service).

20. **ECS rejects task-definition host volumes unless the parent dir is allowlisted.**
    `volumes[].host.sourcePath is rejected by default` — set
    `FLOCI_SERVICES_ECS_HOST_VOLUME_ROOTS` to the directory that contains the mounted path
    (here the nginx config dir). Do NOT use `FLOCI_SERVICES_ECS_ALLOW_UNSAFE_HOST_VOLUMES`: it
    disables the check for every path.

21. **ElastiCache `CreateReplicationGroup` `Port` is the PROXY port, not the container's.** It
    must lie inside the configured proxy range (quirk 14), while the backing valkey container
    always listens on 6379 in-network. A `Port` outside the range fails; the repo's
    `infra/modules/redis/` script omits `Port` and takes Floci's allocation.

22. **`make heal` is the recovery path after a Floci or Docker restart.** It restarts exited
    DocumentDB/Valkey containers, wakes the lazy ECS reconciler (quirk 16), removes orphaned
    ECS task containers, and re-attaches the `nginx-stable` alias (quirk 8). Run it before
    reaching for `make clean && make bootstrap`; `make doctor` says which case you are in.

23. **ALB + ECS services behave differently from AWS** (verified on 2.1.0 by the pre-prod
    environment, `infra/environments/preprod/`). Evidence: [[2026-10-03-floci-preprod-alb-and-ecs-behaviours]].
    - **Container `healthCheck` is stored but never applied** — the Docker container's
      `Healthcheck` is null — and the ALB never health-gates a target: it receives traffic as
      soon as the task starts. A rolling replacement shows **~1-2 s of `503`** (1.8 s measured);
      that window is the emulator, not a regression.
    - **`list_tasks` returns STOPPED tasks; filtering for liveness depends on the use case.** `wait_services.py`
      requires `lastStatus == "RUNNING"` to confirm readiness. `floci_heal.py` and `preprod_targets.py` treat
      a task as dead only when `lastStatus == "STOPPED"` — PENDING/PROVISIONING and describe_tasks failures stay live.
    - **A stopped task's ALB target is never deregistered**: the ALB sends traffic to a dead IP
      (`503`s for 1-2 min) and the target stays unhealthy forever. `preprod_targets.py`
      deregisters targets with no live task after every up, deploy and heal.
    - **The ALB re-sends a body-less request as `transfer-encoding: chunked` with an empty body
      and no `Content-Type`.** Fastify answers `415` unless it accepts an empty body without a
      type (Users does: `services/users/src/shared/http/empty-body-parser.ts`).
    - **The ALB does not carry gRPC** — an HTTP/2 listener answers `502` with a malformed
      header. Reach gRPC through a Docker alias on the task (`users-grpc:50051`).
    - **Fargate rejects 256 CPU / 256 MiB** ("no Fargate configuration"); use 512 MiB.
    - **A `-target` apply still evaluates every service's image tag**, so every image must
      already be pushed before deploying any single service.

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
