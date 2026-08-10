# CLAUDE.md — infrastructure

Nested project memory for the **Terraform/AWS infrastructure**. Source of truth
for the infra stack and conventions. The global `infra-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- IaC: Terraform (own modules; no flat resources).
- Naming: cloudposse/label/null module.
- Cloud: AWS (ECS Fargate + ECR, SQS + Lambda, API Gateway + ALB, Cognito, Route 53, Secrets Manager, Parameter Store, DocumentDB, Aurora Postgres/MySQL).
- Lambda source lives in-repo: `modules/cognito/pre-token-lambda/` (nodejs20.x),
  packaged with the `hashicorp/archive` provider. It is the repo's first Lambda.
- Local: Floci (ADR-0017; superseded Ministack).

## 2. Commands
- Init: `terraform init`
- Validate: `terraform validate`
- Format: `terraform fmt -recursive`
- Plan: `terraform plan`
- Apply: `terraform apply`

> These run per environment under `environments/<env>/`; the configurations
> themselves are created in the infrastructure implementation milestone.

### Local AWS — Floci
Local development runs against **Floci** (local AWS emulator: SQS, Lambda, ECS,
RDS, S3, DocumentDB, …). The **root `docker-compose.yml`** brings it up as the
`floci` service on `3mrai-network`, exposed at `http://localhost:4566`
(in-network: `http://floci:4566`). It is the substrate where local AWS resources
are created; Terraform's `environments/local` and the service SDKs target this
endpoint (`AWS_ENDPOINT_URL`). Lambda/ECS execute as real Docker containers, so
Floci mounts the docker socket and joins them to the same compose network
(`FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network`). State persists in the
`floci-state` **named volume** with `FLOCI_STORAGE_MODE=persistent`.

That volume is not a `./data` bind mount for a specific reason: `docker compose
down -v` removes named volumes and cannot remove a bind mount, so the old layout
had no teardown command that cleared emulator state. It outlived every `down`,
and `make clean` only offered to delete it behind a prompt that defaulted to
KEEPING it — which made a from-scratch rebuild non-deterministic. Floci would
boot, read the stale state, report DocumentDB/ElastiCache as `available`, and
Terraform would create nothing, leaving clusters with no backing container.
`make clean` now runs `down -v`; `make doctor` cross-checks state against
`docker ps` and fails loudly if they drift.

**`make bootstrap` is the single supported entry point.** It runs, in order:
`floci` → `infra-init` → `infra-up` (phase-1 apply + regenerate `./.env` from
outputs via `env-file`) → **`migrate`** (Prisma `migrate deploy`) → build/start
`users` → `bootstrap.sh` (`nginx-stable` alias) → services (`orders`,
`migrate-tracking`, `tracking`). It **stops there**: phase 2 is no longer part of
`bootstrap`, and is run separately with **`make post-infra`** (see the two-phase
section below). The order matters: `users` validates `COGNITO_*` with Zod at boot, and
those IDs only exist after apply — and Floci mints new ones on every apply, so
`.env` is generated, never hand-edited.

Other targets: `make infra-up|infra-down|infra-output`, `make env-file` (rewrites
only the AUTO-GENERATED block in `./.env`, preserving manual vars), `make migrate`,
`make clean` (teardown), `make observability-up|observability-down`.

There are now **two RDS clusters** locally — Users **Postgres** and Orders
**MySQL 8.0** — both from the same engine-agnostic `rds-aurora` module (second
instantiation with `engine = "mysql"`, letter-led `mysql-${label}` id). Both run
`manage_app_user = false`; the least-privilege app users (`users_app` Postgres,
`orders_app` MySQL — each SELECT/INSERT/UPDATE, no DELETE per ADR-0004) are
created post-apply by the **phase-2** `environments/local/post/` root (see the
two-phase apply section below), not inside the phase-1 module. All three are
created locally — `users_app` on Postgres, plus `orders_app` and `tracking_app`
on the shared MySQL cluster.

The mysql provider used to hang against Floci, which is why this was Postgres-only
until 2026-07-30. Re-verified on that date: it creates a user and its grants in
about ten seconds with no drift on a second plan. The old failure is now
explicable — the user came back with `caching_sha2_password`, which demands TLS
that Floci does not terminate; it now uses `mysql_native_password`, so there is
nothing to negotiate.

Note the services still connect as the cluster superuser even so, for a reason
that has nothing to do with Floci: `DATABASE_WRITER_URL` also drives Alembic and
EF Core migrations, and the app users hold no DDL grant by design. Using them at
runtime requires splitting the migration URL from the runtime one first.

Postgres is reached at `floci:<port>` (Floci's RDS proxy port), never by
container IP — Floci reassigns those on every recreation. **Proxy ports are
discovered per-engine, not hardcoded:** Floci assigns them (7000–7099) by cluster
**creation order**, which is NOT stable across applies, so Postgres/MySQL can flip
between 7001/7002 (verified). The single discovery mechanism is
`environments/local/scripts/discover_db_port.py <engine>`, which reads
`aws rds describe-db-clusters --query "DBClusters[?Engine=='<engine>'].Port"`
(the `Engine` field is stable); the Makefile (`env-file`, `migrate`,
`infra-up-post`) and `bootstrap.py` all call it, and `env-file` writes the results
to `.env` as `USERS_DB_PORT`/`ORDERS_DB_PORT` for docker-compose to interpolate.
Writer and reader endpoints are the same locally: Floci does not emulate an Aurora
read replica.

Known limitation: a **second** `terraform apply` fails (Floci's `UpdateTags` for
API GW v2 / RDS). Re-apply by tearing down and rebuilding, not by re-running
apply. See [../docs/lessons/floci-rds-apigw-limits.md](../docs/lessons/floci-rds-apigw-limits.md).

#### SQS / Lambda / DocumentDB (events-pipeline substrate)
Probed empirically on 2026-08-03 against Floci v1.5.28 — full evidence and the
local-vs-AWS classification in
[../docs/lessons/floci-sqs-lambda-docdb-support.md](../docs/lessons/floci-sqs-lambda-docdb-support.md).
**Every limitation below is local-only; none constrains the production design.**

Working as in real AWS: SQS queues, message attributes, visibility timeout,
`ApproximateReceiveCount`, and **automatic DLQ redrive** via `RedrivePolicy`.
The **SQS → Lambda event source mapping genuinely polls and invokes** (verified
from CloudWatch logs: one invocation carrying a 3-record batch), and **partial
batch responses (`batchItemFailures`) are honored** — only the failed item is
retried.

Two things to get right when writing the Terraform:

- **`function_response_types` must be set at create time.** Floci's
  `update-event-source-mapping` silently drops `ReportBatchItemFailures`
  (returns `[]`); `create` persists it correctly. Terraform declares it on
  `aws_lambda_event_source_mapping`, so this is fine — but if the field is ever
  added to an existing mapping, **recreate the mapping, don't update it**, or
  partial batch responses stop being honored and every failure retries the
  whole batch.
- **DocumentDB is NOT discovered like RDS.** It does not appear in
  `aws rds describe-db-clusters` (that only returns mysql/postgres), so
  `scripts/discover_db_port.py` does not apply. `aws docdb describe-db-clusters`
  returns the backing container's **Docker network IP** on port 27017. Floci
  supports a host-published dynamic port in its default (host) mode, but
  **because we run Floci containerized here, 27017 is not published to the
  host** (unlike the RDS proxy ports 7000–7010) — a consequence of our
  deployment mode, not a flat Floci limitation. Do not pin that IP — Floci reassigns
  it on every recreation. The backing container is named
  **`floci-docdb-<db-cluster-identifier>`** (derived from the Terraform cluster
  identifier, not random) and resolves via Docker DNS on `3mrai-network`, so
  connect by that container name. Anything on the host must reach it from
  inside the Docker network.

Floci backs each docdb cluster with a **single standalone `mongo:7.0` container,
no replica set**, so multi-document transactions are unavailable locally
(real Amazon DocumentDB supports them from engine 4.0+). Single-document writes
are atomic, which is all the current design needs.

### Two-phase apply — phase 2 (`environments/local/post/`)
Phase 2 is a **separate, explicit target**: `make post-infra`. `make bootstrap`
does NOT call it — it leaves the stack usable but not hardened. `post-infra`
requires a successful `bootstrap` first: it reads phase 1's state via
`terraform_remote_state`, so against a torn-down phase 1 it fails at that read,
before any provisioner runs. Its first step grants the `test` identity the two
privileges the `mysql` provider needs (`CREATE USER ON *.*`, `SELECT ON mysql.*`),
moved here from phase 1's `create_mysql_database.py` because they are phase-2
prerequisites. Phase 2 lives in `environments/local/post/` with
its **own** (gitignored) state, so it never re-touches phase 1's resources
(which would trip the second-apply `UpdateTags` limit above).

Phase 2 creates the least-privilege **DB app-users in Terraform** via the
engine-parameterized `modules/db-app-user` — replacing the old bash
`bootstrap_app_db_user` step. It reads phase 1's outputs (`db_writer_endpoint`,
`orders_db_writer_endpoint`, `secret_arn`) via `terraform_remote_state`, and the
master credentials **by ARN** via `aws_secretsmanager_secret_version`
(secret-only: no password ever lives in a variable/tfvars/output/`.env`). Each
app-user gets a `random_password` written to its own Secrets Manager secret.
A `terraform_data` + `local-exec` **wait-for-db gate** (`gate.tf` +
`scripts/wait-for-db.sh`, probing over `3mrai_3mrai-network`) blocks app-user
creation until the DB accepts connections.

**Per-engine gating** (`enabled_app_users`): **both** engines are enabled, local
and prod — `users_app` on Postgres, `orders_app` and `tracking_app` on MySQL.
Local was Postgres-only until 2026-07-30, when the mysql provider was re-verified
against Floci (see above). Grants stay SELECT/INSERT/UPDATE, **no DELETE**
(ADR-0004). See [environments/local/post/README.md](environments/local/post/README.md).

`post-infra` discovers **both** proxy ports and passes them as `-var`. It used
to discover only Postgres, leaving mysql on a default of 7002 — and a live check
on 2026-07-30 found mysql on 7001 and postgres on 7002, exactly reversed. Floci
assigns those by cluster creation order, so no default is reliable.

Updated `make bootstrap` order: `floci` → `infra-init` → `infra-up` (phase 1
apply + `env-file`) → `migrate` → build/start `users` → `bootstrap.sh`
(nginx-stable alias) → `orders` → `migrate-tracking` → `tracking`. Phase 2 is
**not** in this chain any more — run `make post-infra` after it.

Every `local-exec` provisioning script (the awscli-fallback pattern) records its
run to a DynamoDB `execution_log` table declared in `modules/tf-backend`, beside
the state-lock table — for **traceability, never to skip a re-run**, and fail-open
so an unreachable table never blocks provisioning. Full argument:
[../docs/infrastructure/decisions/two-phase-terraform-apply.md](../docs/infrastructure/decisions/two-phase-terraform-apply.md).

## 3. Folder structure
```
infra/
├── modules/
│     label/        — cloudposse/label wrapper (naming)
│     networking/   — VPC, subnets, security group
│     compute/      — nginx on ECS (njs injects x-user-id; see ADR-0016)
│     api-gateway/  — API GW v2, per-route HTTP_PROXY integrations, JWT authorizer
│     cognito/      — user pool (+ custom:app_user_id), app client, and the repo's
│                     first Lambda: Pre-Token-Generation V2 (pre-token-lambda/)
│     rds-aurora/   — Aurora cluster (writer + reader), engine-agnostic: one
│                     instantiation per engine (postgres for users, mysql for orders)
│     docdb/        — DocumentDB cluster + instance (the events-pipeline event
│                     store). NOT a generic "database" module — that was its old
│                     name, and it only ever created DocumentDB. It stays separate
│                     from rds-aurora on purpose: different AWS resource families,
│                     providers and lifecycles, so merging them would only produce
│                     a switch-module with no shared resources.
│     messaging/    — SQS events queue + DLQ (redrive)
│     lambda/       — function, IAM role, SQS event source mapping
│     db-app-user/  — least-privilege application DB user (phase 2; engine-parameterized)
└── environments/{local,production}/
```

Two modules are wired against Floci with the **awscli-fallback pattern**
(`terraform_data` + `local-exec` + an idempotent script, outside Terraform's
resource lifecycle) because native resources cannot work there: the Cognito app
client and the Pre-Token V2 trigger. See [[awscli-fallback-for-floci]] and
[[cognito-pre-token-lambda]]. The AWS provider is pinned `= 5.31.0`.

## 4. Conventions (referenced, never duplicated)
- cloudposse/label naming: [../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md](../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md)
- Read/write replicas: [../docs/shared/decisions/ADR-0006-read-write-replicas.md](../docs/shared/decisions/ADR-0006-read-write-replicas.md)
- Secrets & Parameter Store: [../docs/shared/decisions/ADR-0007-secrets-parameter-store.md](../docs/shared/decisions/ADR-0007-secrets-parameter-store.md)
- API GW → ALB → Fargate: [../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md](../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md)
- Cognito auth: [../docs/shared/decisions/ADR-0010-cognito-auth.md](../docs/shared/decisions/ADR-0010-cognito-auth.md)
- Observability (OpenObserve): [../docs/shared/decisions/ADR-0018-observability-openobserve.md](../docs/shared/decisions/ADR-0018-observability-openobserve.md) (supersedes ADR-0011, SigNoz)
- Local API GW → nginx ECS (no ALB locally): [../docs/shared/decisions/ADR-0016-local-apigw-nginx-ecs.md](../docs/shared/decisions/ADR-0016-local-apigw-nginx-ecs.md)
- Floci local: [../docs/shared/decisions/ADR-0017-floci-local.md](../docs/shared/decisions/ADR-0017-floci-local.md) (supersedes ADR-0012, Ministack)
- Scripting language (Python first): [../docs/shared/conventions/scripting-language.md](../docs/shared/conventions/scripting-language.md)
- Env files (generated, never hand-edited): [../docs/shared/conventions/env-files.md](../docs/shared/conventions/env-files.md)

### Env files are generated here
`environments/local/scripts/generate_env_files.py` writes all five env files from
Terraform outputs; `make env-file` runs it, and `infra-up` ends by calling that —
so every file exists before any service starts. That ordering is load-bearing now
that services read `.env.local.<service>` via compose `env_file:`.

- Rewrites only each file's **AUTO-GENERATED** box; the **CUSTOM** box is preserved.
- Every value is REQUIRED: a missing Terraform output raises, naming it, rather
  than writing an empty segment into a connection string (a service that starts
  and then cannot connect is far harder to diagnose).
- **No interpolation in the output.** `env_file:` takes values literally, so ports
  and ids are resolved as the file is written — a `${...}` left behind would reach
  the service as that literal string.
- Adding a service: add its entry to the generator and an `env_file:` line to its
  compose service. Declare nothing inline — `environment:` silently wins.

### Infra scripts are Python
All five infra scripts are Python (`bootstrap.py`, `scripts/discover_db_port.py`,
`post/scripts/wait_for_db.py`, `modules/cognito/scripts/create_user_pool_client.py`,
`modules/cognito/scripts/set_pre_token_trigger.py`) — there are **no `.sh` files** left.

- They import shared helpers from `infra/scripts/lib3mrai/` (`aws.py` boto3 factory
  honoring `AWS_ENDPOINT_URL`, `console.py` ok/no/inf, `db.py` discover_port/wait_for_db).
  Add shared logic there rather than duplicating it per script.
- Each script stays **colocated** with the Terraform module that invokes it.
- `local-exec` provisioners call the venv interpreter by **absolute path**, passed in as
  `var.python_bin` (the root module resolves it from its own `path.root`; the shared
  cognito module requires it with no default, so a wrong wiring fails at plan time).
  Never plain `python3` — the ambient one may resolve into an unrelated venv.
- `make scripts-setup` creates `.venv/` and is a prerequisite of every apply target, so a
  fresh clone cannot hit `python: not found` from inside an apply.
- When porting or editing, preserve the external interface: CLI args, exit codes, env var
  names, state-file shapes, and stdout purity where the Makefile captures it.

## 5. Agent rules
- Converse with the user in **Spanish**; write config and comments in **English**.
- `infra-impl` writes **only Terraform/config** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Infra specs (vault): [../docs/infrastructure/specs/](../docs/infrastructure/specs/)
- Scaffold design: [../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md](../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md)
