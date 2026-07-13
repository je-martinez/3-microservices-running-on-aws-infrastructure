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
(`FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network`). State persists under
`./data/floci` (git-ignored) with `FLOCI_STORAGE_MODE=persistent`.

**`make bootstrap` is the single supported entry point.** It runs, in order:
`floci` → `infra-init` → `infra-up` (apply + regenerate `./.env` from outputs via
`env-file`) → **`migrate`** (Prisma `migrate deploy`) → build/start `users` →
`bootstrap.sh` (least-privilege DB user + `nginx-stable` alias). The order
matters: `users` validates `COGNITO_*` with Zod at boot, and those IDs only exist
after apply — and Floci mints new ones on every apply, so `.env` is generated,
never hand-edited.

Other targets: `make infra-up|infra-down|infra-output`, `make env-file` (rewrites
only the AUTO-GENERATED block in `./.env`, preserving manual vars), `make migrate`,
`make clean` (teardown), `make observability-up|observability-down`.

Postgres is reached at `floci:7001` (Floci's RDS proxy port), never by container
IP — Floci reassigns those on every recreation. Writer and reader endpoints are
the same locally: Floci does not emulate an Aurora read replica.

Known limitation: a **second** `terraform apply` fails (Floci's `UpdateTags` for
API GW v2 / RDS). Re-apply by tearing down and rebuilding, not by re-running
apply. See [../docs/lessons/floci-rds-apigw-limits.md](../docs/lessons/floci-rds-apigw-limits.md).

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
│     rds-aurora/   — Aurora cluster (writer + reader)
│     database/, messaging/  — empty placeholders
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

## 5. Agent rules
- Converse with the user in **Spanish**; write config and comments in **English**.
- `infra-impl` writes **only Terraform/config** — never runs git or touches Linear.
- Leave finished work in the working tree for the **main session** to commit
  (`github-ops` is an optional helper for complex git batches — see [[git-workflow]]).
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Infra specs (vault): [../docs/infrastructure/specs/](../docs/infrastructure/specs/)
- Scaffold design: [../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md](../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md)
