---
title: "JE-36 — Compose environments/local + apply Users chain on Floci — Design"
type: spec
area: infra
status: draft
created: 2026-07-04
updated: 2026-07-04
tags: [type/spec, area/infra, status/draft, issue/JE-36]
related: ["[[users-service-milestone]]", "[[ADR-0017-floci-local]]", "[[floci-vs-ministack-spike-findings]]", "[[local-dev]]", "[[git-workflow]]", "[[soft-delete]]"]
---

# JE-36 — Compose environments/local + apply Users chain on Floci — Design

> [!important] Revision 2 (post-apply findings)
> The first `terraform apply` against Floci surfaced concrete emulation gaps not anticipated
> by the original design below (modules were validated against Ministack). See
> **[Revision 2 — Floci emulation gaps + discrete app DB user](#revision-2--floci-emulation-gaps--discrete-app-db-user)**
> at the end of this spec, which supersedes the "Non-goals: don't touch modules" stance with
> minimal, backward-compatible module edits and adds a least-privilege application DB user.
> The sections below are kept as the original record of the compose-only approach.

## Summary

Compose the six existing Terraform modules (`label`, `networking`, `rds-aurora`, `cognito`,
`compute`, `api-gateway`) into a single `infra/environments/local` root module targeting
**Floci** (the local AWS emulator at `localhost:4566`), apply it, attach the stable nginx DNS
alias, run the Prisma migration to create the `users` table, and verify the acceptance
criterion: `GET /v1/health` returns 200 through the API Gateway invoke URL from Terraform
outputs.

This is the integration point where all infrastructure and application code converge into a
running end-to-end stack on the local AWS substrate. **JE-36 was written for Ministack; the repo
has since migrated to Floci** (see [[ADR-0017-floci-local]], [[floci-vs-ministack-spike-findings]]).
The modules were already authored against the Floci spike, so this work is **composition and
wiring**, not module rewrites. We start fresh on current `feature/users-service` — the stale
`feat/JE-36-local-env-apply` branch (Ministack-era, 7 commits behind) is archived, not reused.

## Context / verified facts

- **The six modules exist** with real `.tf` and are already Floci-aligned:
  - `api-gateway` uses **API Gateway v2** + a **JWT authorizer** (`aws_apigatewayv2_*`), matching
    the spike (comments say "Proven in the spike").
  - `compute` runs an **nginx:alpine ECS task** that proxies to a backend **by DNS**
    (`resolver 127.0.0.11; set $backend ${var.backend_service_name}; proxy_pass http://$backend:${var.backend_port}`)
    — no IP patching.
  - `rds-aurora` emits `writer_endpoint`, `reader_endpoint`, `secret_arn`, `port`.
  - `label` produces the cloudposse-style `context`; `networking` produces `vpc_id`, `subnet_ids`,
    `security_group_ids`.
- **Module input wiring** (verified from each `variables.tf`):
  - `label` → `context`, consumed by every other module.
  - `networking(context, vpc_cidr, subnets)` → vpc/subnets/SGs → `rds-aurora`, `compute`.
  - `rds-aurora(context, subnet_ids, security_group_ids, database_name, master_username, master_password, engine_version, instance_class, skip_final_snapshot)` → writer/reader endpoints.
  - `cognito(context, region, password_minimum_length)` → issuer + audience.
  - `compute(context, vpc_id, subnet_ids, security_group_ids, backend_service_name, backend_port, cpu, memory, log_retention_days, region)` → ECS cluster + nginx + `nginx_integration_uri`.
  - `api-gateway(context, cognito_issuer, cognito_audience, nginx_integration_uri, enable_e2e_cleanup_route)` → invoke URL.
- **The Floci spike (`infra/environments/local/spike-floci/`) PASSED** the full auth chain
  (API GW v2 JWT authorizer → Cognito → nginx ECS → backend). Its `providers.tf` declares the
  `endpoints` block to `localhost:4566` for every service used — this is the proven provider config.
- **A stable-DNS bootstrap is required.** Floci recreates the nginx ECS task with a volatile
  container name/IP each apply, and its Route53/Cloud Map is management-plane only (no resolution).
  The spike's `bootstrap.sh` attaches a **constant Docker network alias** (`nginx-stable`) to the
  running nginx container; the API GW integration points at `http://nginx-stable/`, so no
  post-apply IP patch and no Terraform state drift. This bootstrap is part of the flow, run once
  after each apply (idempotent).
- **The `users` service** listens on `:3000` (Fastify) and is on `3mrai-network` in
  docker-compose; the local Makefile + `.http` (see [[local-dev]]) already publish it and exercise
  `/v1/health`, `/v1/users/*`.

## Goals

- `infra/environments/local/{providers,terraform,variables,main,outputs}.tf` composing the six
  modules with correct output→input wiring, targeting Floci.
- nginx (compute module) proxies to the **real `users` service** (`backend_service_name = "users"`,
  `backend_port = 3000`) — not the `spike-backend` echo.
- `terraform apply` completes against a running Floci.
- The stable nginx DNS alias is attached after apply (adapted bootstrap).
- `pnpm --filter @3mrai/users prisma migrate deploy` creates the `users` table (incl. `tags`
  column) against the provisioned Aurora Postgres **writer** endpoint.
- **Acceptance:** `GET /v1/health` → 200 through the API Gateway invoke URL from Terraform outputs.
- The flow is orchestrated from the root `Makefile` (extending the existing one).
- Ministack→Floci text sync: JE-36 in Linear and `users-service-milestone.md` updated to Floci.

## Non-goals (YAGNI)

- **Not** rewriting the six modules — they are already Floci-aligned; adapt wiring only if apply
  reveals a concrete gap.
- **Not** reusing/rebasing the stale `feat/JE-36-local-env-apply` branch.
- **Not** starting JE-37 (e2e specs) or JE-38 (Cognito webhook) — out of scope; JE-36 only.
- **Not** rewriting `infra/CLAUDE.md`'s Ministack wording — flagged as a follow-up, not in scope.
- **Not** touching `spike/` or `spike-floci/` — they stay as reference; the new work is a sibling
  `environments/local` root composition.
- **Not** deleting the archived branch without explicit user approval.

## Components

### 1. `infra/environments/local/providers.tf`

AWS provider with the Floci `endpoints` block and compatibility flags, copied from the proven
`spike-floci/providers.tf` (region `us-east-1`, `access_key/secret_key = test`, path-style S3,
skip-* flags). Declare every service the six modules use: at minimum `apigatewayv2`, `cognitoidp`,
`ec2`, `ecs`, `elbv2`, `iam`, `logs`, `rds`, `route53`, `servicediscovery`, `sts`. (The plan will
reconcile the exact list against what `rds-aurora` needs — the spike did not exercise RDS, so
`rds` is the one endpoint to add beyond the spike's set.)

### 2. `infra/environments/local/terraform.tf`

`required_providers` (hashicorp/aws, pinned to the same version the modules/spike use) and the
`terraform { required_version }` block.

### 3. `infra/environments/local/variables.tf`

Environment inputs with local-dev defaults: `environment` (default `"local"`), `image_tag`,
`vpc_cidr`, `subnets`, and DB credentials (`db_name`, `db_username`, `db_password` — test defaults
matching the compose `DATABASE_WRITER_URL`). No secrets committed; defaults are the known test
values already in `docker-compose.yml`.

### 4. `infra/environments/local/main.tf`

Instantiate and wire the six modules:

```
module "label"      { source = "../../modules/label"      ... }
module "networking" { source = "../../modules/networking" context = module.label.context ... }
module "rds_aurora" { source = "../../modules/rds-aurora"
                      context = module.label.context
                      subnet_ids = module.networking.subnet_ids
                      security_group_ids = [module.networking.security_group_id]
                      database_name = var.db_name ... }
module "cognito"    { source = "../../modules/cognito" context = module.label.context region = "us-east-1" }
module "compute"    { source = "../../modules/compute"
                      context = module.label.context
                      vpc_id = module.networking.vpc_id
                      subnet_ids = module.networking.subnet_ids
                      security_group_ids = [module.networking.security_group_id]
                      backend_service_name = "users"
                      backend_port = 3000 ... }
module "api_gateway"{ source = "../../modules/api-gateway"
                      context = module.label.context
                      cognito_issuer = module.cognito.issuer
                      cognito_audience = module.cognito.client_id
                      nginx_integration_uri = module.compute.nginx_integration_uri
                      enable_e2e_cleanup_route = true }
```

(Exact output attribute names — `module.networking.security_group_id` vs `.security_group_ids`,
`module.cognito.issuer` vs `.user_pool_id` — are resolved in the plan by reading each module's
`outputs.tf`; the plan lists them verbatim so there are no guesses.)

### 5. `infra/environments/local/outputs.tf`

Expose: `api_invoke_url` (api-gateway), `cognito_user_pool_id` + `cognito_client_id` (cognito),
`db_writer_endpoint` + `db_reader_endpoint` (rds-aurora). These feed the migration command and
JE-37's e2e config.

### 6. Stable-DNS bootstrap

Adapt `spike-floci/bootstrap.sh` (attach `nginx-stable` Docker alias to the running nginx ECS
container) into the environments/local flow. Either a script at
`infra/environments/local/bootstrap.sh` or a Makefile recipe. Idempotent; run once after apply.
The `api-gateway` module's integration URI must point at `http://nginx-stable/` (confirm the
module already does, or pass it as the integration target).

### 7. Makefile orchestration

Extend the root `Makefile` (see [[local-dev]]):
- Repoint (or add) the `infra-*` targets to `infra/environments/local` for the real compose
  (keep `spike-floci` reachable via a separate variable if useful, or retire it from the default).
- Add `db-migrate` — `pnpm --filter @3mrai/users prisma migrate deploy` against the writer
  endpoint from `terraform output`.
- Extend `bootstrap` to: `up` → wait for Floci → `terraform apply` (environments/local) →
  attach nginx-stable alias → `db-migrate` → curl the health check.

### 8. Text sync (Ministack → Floci)

- **Linear:** `linear-pm` proposes updating JE-36's title/description to say Floci (user confirms).
- **Vault:** `obsidian-vault` updates the JE-36 row/wording in `docs/plans/users-service-milestone.md`
  and the local-dev runbook to reflect the Floci flow.

## Write ownership

| Target | Writer |
| --- | --- |
| `infra/environments/local/*.tf`, bootstrap | main session (or `infra-impl`; decided in plan) |
| root `Makefile` (extend) | main session |
| `docs/plans/users-service-milestone.md`, runbook | `obsidian-vault` |
| JE-36 title/description in Linear | `linear-pm` (user confirms) |

Branch: a fresh task branch off `feature/users-service` (e.g. `feat/JE-36-local-env-compose`).
One PR into `feature/users-service`. JE-36 moves to In Progress (already is) → Done after merge.

## Testing / validation

- `terraform -chdir=infra/environments/local validate` passes; `plan` produces a clean graph
  (all six modules, wired).
- `terraform apply` completes against a running Floci with no errors.
- After the nginx-stable bootstrap, `curl <api_invoke_url>/v1/health` → **200** (the JE-36
  acceptance criterion).
- `prisma migrate deploy` reports the migration applied; the `users` table exists (verify via a
  `\dt` / a `SELECT` through the writer endpoint, or a subsequent register call).
- `node scripts/validate-vault.mjs` passes for the doc updates.

## Risks / honest stop points

- **Aurora Postgres on Floci.** The spike did **not** exercise RDS. If Floci does not emulate a
  usable Postgres writer endpoint (connectable, migratable), `prisma migrate deploy` will fail.
  This is the highest-risk unknown. If it blocks, **stop and report** — do not fake the migration
  or claim the acceptance criterion passed. Options at that point (fall back to the compose
  Postgres, or a Floci RDS workaround) become a follow-up decision, surfaced to the user.
- **nginx-stable alias timing.** The alias must be attached after the ECS task is actually running;
  the bootstrap must poll/retry (idempotent) rather than assume immediate readiness.
- **Endpoint completeness.** Any AWS service a module calls that is missing from the `endpoints`
  block makes Terraform hit real AWS. The `rds` endpoint is the known addition beyond the spike's
  set; the plan double-checks the full list against the composed modules.

## Revision 2 — Floci emulation gaps + discrete app DB user

The first `terraform apply` against Floci created **21/28** resources, then failed on two
Floci-vs-module mismatches. Root causes were confirmed via the `floci` skill and the official
Floci RDS docs. This revision supersedes the compose-only stance with **minimal,
backward-compatible module edits** (defaults preserve current prod behavior), and folds in a
**least-privilege application DB user** created as IaC.

### Evidence from the apply (honest record)

- **Cognito client:** `Provider produced inconsistent result ... analytics_configuration: block
  count changed from 0 to 1`. Floci returns `AnalyticsConfiguration: {}`; the provider reads it
  as a present block and aborts. (`floci` skill quirk #2.)
- **RDS Aurora:** `aws_db_subnet_group ... DBInstanceNotFound 404` — the Aurora cluster did not
  create. Root cause: the `rds-aurora` module hardcodes `engine = "aurora-postgresql"`, but Floci
  runs **real DB containers only for `postgres`/`mysql`/`mariadb`** (official RDS docs) and
  exposes them on a **proxy port `localhost:7000-7099`**, not `:4566`.
- **Cognito issuer (latent):** the module's `issuer` output is AWS-format
  (`https://cognito-idp.<region>.amazonaws.com/<pool-id>`) and its comment says `localhost:4566`
  caused 401 **on Ministack**. But the `floci` skill quirk #5 says **Floci** needs
  `http://localhost:4566/<pool-id>` or tokens 401 — opposite behavior. This contradiction is
  resolved by **empirical validation at apply time**, not by trusting either doc.

### Change A — RDS engine switchable (module `rds-aurora`)

- Add `variable "engine"` (default `"aurora-postgresql"` → prod unchanged). `environments/local`
  passes `engine = "postgres"` and `instance_class = "db.t3.micro"` (Floci's default class).
- **DB endpoint discovery:** after apply, the real connectable host:port is discovered via
  `aws rds describe-db-instances` (Floci proxy port), NOT the module's AWS-format
  `writer_endpoint`. The migration `DATABASE_URL` is built from the discovered value.

### Change B — Cognito Floci compatibility (module `cognito`)

- Add `lifecycle { ignore_changes = [analytics_configuration] }` to
  `aws_cognito_user_pool_client.this`. The client is created and functional regardless.
- Make the `issuer` **switchable** — add a module variable (default AWS-format for prod/Ministack);
  `environments/local` passes the Floci style `http://localhost:4566/<pool-id>`. **Validated
  empirically at apply:** present a token to a protected route and adjust the issuer style based
  on the real 200/401, not on the contradictory docs.

### Change C — Least-privilege application DB user (module `rds-aurora`)

Formalize the module's existing manual "In-DB grant note" (the `CREATE USER ... GRANT SELECT,
INSERT, UPDATE` SQL currently documented as a post-apply manual step) into IaC using the
[`cyrilgdn/postgresql`](https://registry.terraform.io/providers/cyrilgdn/postgresql/latest/docs)
provider. This enforces the repo's **soft-delete-only** policy at the DB grant level
(see [[soft-delete]]: "the database write user is granted no DELETE privilege").

- **One application user**, gated by a module variable (e.g. `manage_app_user`, default off so
  prod/other envs opt in explicitly):
  - `postgresql_role` with a `random_password`-generated password.
  - `postgresql_grant`s: `CONNECT` on the database, `USAGE` on `public`, and
    **`SELECT, INSERT, UPDATE` (NOT `DELETE`)** on tables, plus `ALTER DEFAULT PRIVILEGES` so
    future tables inherit the same grants. Exactly the SQL the module documents today.
- **Credentials as a secret:** the app user's password is stored in an
  `aws_secretsmanager_secret` (the module already creates one for the master; add one for the app
  user). `environments/local` exposes the secret (ARN/value) as an output so the container's
  `DATABASE_URL` is built from the least-privilege app credentials, not the master.
- **Provider ordering (validated, not assumed):** `cyrilgdn/postgresql` must connect to a
  *running* Postgres, and Floci's proxy port is only known post-creation. The plan attempts to
  configure the provider against the cluster endpoint, but treats the ordering as an unknown to
  validate live: if the provider can't connect in the same apply, split into two steps
  (apply cluster → discover endpoint → apply role/grants, e.g. via `-target`) rather than forcing
  a single apply. Decide from the real output.

### Revised non-goals / scope note

- The original "do not rewrite the six modules" non-goal is **consciously reverted** for the two
  modules above, limited to **additive, backward-compatible** edits whose defaults preserve
  current behavior. No behavioral change for prod unless an env opts in (`engine`, `manage_app_user`,
  issuer style).
- Still out of scope: JE-37/JE-38, `infra/CLAUDE.md` Ministack→Floci wording (follow-up),
  the second (reader-only) DB user (one app user for now, per decision).

### Revised acceptance (empirical)

1. `terraform apply` (with `engine=postgres`) creates the Postgres cluster on Floci.
2. The app DB user exists with `SELECT, INSERT, UPDATE` and **no `DELETE`** (verify via
   `\du`/`information_schema.role_table_grants`).
3. `prisma migrate deploy` (using the **app user** credentials from the secret, against the
   **discovered** endpoint) creates the `users` table.
4. `GET /v1/health` (public route) → **200** through the API Gateway invoke URL.
5. Issuer style confirmed by a real token test on a protected route (200), or the 401 is
   understood and the issuer style corrected.

### Revised risks / stop points

- The Floci/Aurora stop point still stands: if `engine=postgres` still doesn't yield a
  migratable DB on Floci, STOP and report — do not fake it.
- If the `cyrilgdn/postgresql` provider cannot connect post-apply and the two-step split also
  fails, STOP and surface it — do not silently drop the app-user requirement.

## Related

- [[users-service-milestone]]
- [[soft-delete]]
- [[ADR-0017-floci-local]]
- [[floci-vs-ministack-spike-findings]]
- [[local-dev]]
