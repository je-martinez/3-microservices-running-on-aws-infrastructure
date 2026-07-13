---
title: "Floci RDS + API Gateway limits (JE-36)"
type: lesson
area: infra
status: active
created: 2026-07-04
updated: 2026-07-09
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
  - issue/JE-36
related:
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0017-floci-local]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
---

# Floci RDS + API Gateway limits (JE-36)

Empirical limits of the Floci local emulator discovered while composing the Aurora/RDS +
API Gateway chain against Floci for [JE-36](https://linear.app/je-martinez/issue/JE-36). These
are gate-passed facts recorded for future infra work — the Orders and Tracking services use the
same stack (RDS-backed persistence behind API Gateway) and will hit the same constraints.

## Context

While implementing JE-36 (compose the six Terraform modules into `environments/local` and apply
against Floci), empirical apply testing surfaced limits NOT in the floci skill's quirk list.
Recorded here so future infra work (Orders, Tracking) doesn't re-discover them.

## What WORKS on Floci (verified)

- **RDS Postgres via `engine = "postgres"`** — Floci runs a real Postgres 14.6 container.
  `aws_rds_cluster` creates and reports `available`. Connect at the Floci proxy endpoint (e.g.
  `192.168.155.5:7001`, proxy range 7000-7099), reachable from the host on macOS and from the
  compose network.
- **`cyrilgdn/postgresql` provider** — creating a least-privilege app role + grants works against
  the running Postgres. Verified a role with SELECT/INSERT/UPDATE and NO DELETE (pg_default_acl
  `arw`, and `information_schema.role_table_grants` on the migrated table shows only
  INSERT/SELECT/UPDATE).
- **Prisma `migrate deploy`** — applies against the discovered proxy endpoint (run as the master
  user; DDL needs privileges the least-privilege app user intentionally lacks).
- **The internal proxy chain** — nginx (ECS) → users: `nginx-stable` alias + `location / {
  proxy_pass http://users:3000; }` forwards the path correctly (direct `wget
  http://nginx-stable/v1/health` → `{"status":"ok"}`).

## Hard limits (NOT fixable at module/config level)

1. **`ListTagsForResource` / tag updates fail for RDS + API Gateway resources.** Floci
   mis-routes the tag call for a DB subnet group ARN (`subgrp`) as a DB instance →
   `DBInstanceNotFound 404`, for ANY subnet group (even the untagged `default`). The same class of
   failure hits the RDS **cluster** (tag update → `DBInstanceNotFound`) and the **API Gateway v2
   stage** (tag update → `Invalid API id`). The AWS provider issues these tag reads/writes as part
   of the resource lifecycle, so they can't be avoided while the resource is provider-managed.
   Floci's own RDS docs list tagging as supported — so this is a Floci bug diverging from its
   docs, with no config flag to disable it.
   - **Workaround used:** don't let Terraform manage the DB subnet group under Floci — point the
     cluster at Floci's pre-existing `default` subnet group (a `create_subnet_group=false` +
     `subnet_group_name="default"` path in the rds-aurora module).
   - **Concrete consequence (verified 2026-07-09): a SECOND `terraform apply` against a live Floci
     environment fails.** From a blank slate (`data/floci` wiped, tfstate deleted), `terraform
     apply` creates 25 resources and exits 0. Running `terraform apply` again against that same
     live environment fails with:
     ```
     Error: updating tags for API Gateway V2 Stage (arn:aws:apigateway:us-east-1::/apis/<id>/stages/$default):
       tagging resource ...: NotFoundException: Invalid API id specified

     Error: updating tags for RDS (Relational Database) Cluster (arn:aws:rds:us-east-1:000000000000:cluster:aurora-3mrai-local-aurora-aurora):
       tagging resource ...: DBInstanceNotFound: DB instance <arn> not found.
     ```
     So the practical rule is: **on Floci, only a from-scratch apply is reliable — re-applying
     against a live environment is not.**
2. **API Gateway v2 HTTP_PROXY does not forward the request path.** With `integration_uri =
   "http://nginx-stable/"` and an explicit route `GET /v1/health`, Floci delivers `GET /` (root)
   to the backend — the `/v1/health` suffix is dropped (confirmed in the users/nginx logs). Floci
   does NOT expand API GW v2 integration path variables: `integration_uri =
   "http://nginx-stable/{proxy}"` → 404; `"http://nginx-stable${request.path}"` → 502, still
   `GET /` at nginx. So a request to the Floci API Gateway invoke URL cannot reach the backend
   with its original path. (The Floci spike appeared to work only because its echo backend
   ignored the path.)

## Non-idempotency (fixable)

- `aws_rds_cluster` wanted destroy/recreate on every apply because Floci returns `engine_mode`
  differently than the provider expects for postgres (`engine_mode = "provisioned"` shows "forces
  replacement"). Fix: `lifecycle { ignore_changes = [engine_mode] }` on the cluster — after which
  re-apply is `update in-place` and the migrated data survives.
- Residual cosmetic drift remains on `tags`/`tags_all` and `vpc_security_group_ids` (Floci returns
  a placeholder `sg-00000000`), non-destructive.

## ECS recreated on every apply (separate defect from the tag failures)

Verified 2026-07-09, on the SAME second-apply run described above: the plan reports `Plan: 2 to
add, 7 to change, 2 to destroy`, including:

```
# module.compute.aws_ecs_service.nginx must be replaced
# module.compute.aws_ecs_task_definition.nginx must be replaced
```

Floci recreates the ECS task definition and service on EVERY `terraform apply`. This matches
floci skill quirk #8 ("ECS task is recreated on every terraform apply"). This is a DIFFERENT
defect from the tag-update failures above — it would keep happening even if the tag bug were
worked around.

> [!info] Plausible (not proven) link to the `.tmp` corruption finding
> Because every apply rewrites `ecs-task-definitions.json`, that file is the same one found
> truncated mid-serialization as an orphaned `.tmp` in
> [[floci-storage-modes-and-tmp-corruption]]. The repeated rewrite on every apply is a plausible
> mechanism for what exposes that corruption window — but this is a hypothesis, not established
> causation. See that note's "Finding 2" for what was and was NOT proven.

## Decision recorded (2026-07-09): accept and document, don't work around

Fixing the tag churn would mean adding `ignore_changes`/gating to `modules/api-gateway`,
`modules/networking`, `modules/compute`, and `modules/rds-aurora` — and the last module is
**shared with production**, where the real AWS RDS/API Gateway APIs tag correctly. Paying a
production-regression risk to patch around an emulator bug is the wrong trade, so no module
changes were made for this.

The real local-dev workflow — `make bootstrap` from a clean slate — already works and is the
supported path; a second in-place `terraform apply` is not.

### Operational guidance — re-apply by tearing down, not by re-running apply

To make further Terraform changes locally, don't run `terraform apply` a second time against a
live environment. Tear down and rebuild instead:

```bash
docker compose down && rm -rf data/floci && rm -f infra/environments/local/terraform.tfstate*
make bootstrap
```

`make bootstrap` is the single supported entry point for local dev. It runs, in order: start
Floci → `terraform apply` (from scratch) → regenerate `.env` from Terraform outputs → build/start
the `users` service → run `bootstrap.sh` (creates the least-privilege DB user and the
`nginx-stable` alias).

## Implication

Floci is suitable for local dev of the Postgres data layer and the internal service chain, but
the **API Gateway v2 path-forwarding limit** means an end-to-end "health through the API Gateway
invoke URL" check is not achievable on Floci. Local acceptance for services should target the
internal chain (service reachable via nginx with the correct path) rather than the Floci API GW
invoke URL. Revisit if Floci adds path forwarding.

## Related

- [[floci-vs-ministack-spike-findings]]
- [[ADR-0017-floci-local]]
- [[floci-storage-modes-and-tmp-corruption]]
