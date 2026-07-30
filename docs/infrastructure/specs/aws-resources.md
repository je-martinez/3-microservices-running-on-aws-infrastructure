---
title: AWS Resources
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-07-30
tags: [type/spec, area/infra, status/active]
related:
  - ADR-0006-read-write-replicas
  - ADR-0007-secrets-parameter-store
  - ADR-0010-cognito-auth
  - "[[ADR-0018-observability-openobserve]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[rds-aurora-engine-switchable-floci]]"
  - "[[two-phase-terraform-apply]]"
---

# AWS Resources

## Summary

Catalogue of every AWS resource used by 3MRAI, organised by service type. Provisioned via
the Terraform modules described in [[terraform-modules]]. Key decisions: read/write replicas
([[ADR-0006-read-write-replicas]]), secret storage ([[ADR-0007-secrets-parameter-store]]),
and authentication ([[ADR-0010-cognito-auth]]).

## Stack & Data Store

### Container & Registry

| Resource | Detail |
|---|---|
| ECS Fargate cluster | One cluster per environment; one service per microservice |
| ECR repository | One repo per service (`3mrai-{env}-{service}`); image scanning enabled |
| Task definitions | CPU/memory set per service; secrets injected from Secret Manager |
| ALB target groups | One per service; health check path `GET /v1/health` — see [[networking]] |

### Relational Databases (RDS Aurora)

Two Aurora clusters, one per engine:

| Cluster | Engine | Used by |
|---|---|---|
| `aurora-postgres` | Aurora PostgreSQL | `users-service`, `orders-service` |
| `aurora-mysql` | Aurora MySQL | `tracking-service` |

Both clusters follow the read/write replica pattern from [[ADR-0006-read-write-replicas]]:

- **Writer endpoint** — receives all `INSERT`, `UPDATE` commands (no `DELETE` — see [[soft-delete]]).
- **Reader endpoint** — load-balanced across one or more read replicas for `SELECT` queries.
- Automated backups: 7-day retention; point-in-time recovery enabled.

Locally (Floci), both clusters are provisioned by the same engine-agnostic `rds-aurora` module
instantiated with a real, non-Aurora engine (`postgres` for Users, `mysql` for Orders/Tracking),
since Floci emulates single-instance Postgres/MySQL containers, not Aurora — see
[[rds-aurora-engine-switchable-floci]]. Least-privilege app users (`users_app`, `orders_app`,
`tracking_app`; `SELECT, INSERT, UPDATE`, never `DELETE`) are created by a second, dedicated
Terraform apply phase once the cluster endpoint is live, rather than by post-apply bash — see
[[two-phase-terraform-apply]]. As of 2026-07-30 both Postgres and MySQL app-users are managed by
Terraform (`enabled_app_users` defaults to `["postgres", "mysql"]`); the earlier belief that
Floci's MySQL provider could not manage users at all turned out to be a TLS/auth-plugin mismatch
(`caching_sha2_password` demands TLS Floci doesn't terminate), not a real limitation — see
[[two-phase-terraform-apply#Update 2026-07-30 — the MySQL provider no longer hangs]] for the
full account. The modules validate, but phase 2 has not yet been applied, so `orders_app` and
`tracking_app` do not exist in the local database today.

### Messaging

| Resource | Detail |
|---|---|
| SQS queues | One standard queue per domain event type; DLQ attached (max receives = 3) |
| Lambda functions | One function per CQRS read-model handler; triggered by SQS |

### Document Store

| Resource | Detail |
|---|---|
| DocumentDB cluster | Stores event-sourcing projections for `events-pipeline`; compatible with MongoDB 5.0 |

### Auth

| Resource | Detail |
|---|---|
| Cognito User Pool | Single pool for all services; carries a `custom:app_user_id` custom attribute (the Prisma `usr_` id) set by `register` at sign-up |
| Cognito App Client | One app client per environment; issues JWTs validated at API Gateway |
| Pre-Token-Generation V2 Lambda | The repo's first Lambda — copies `custom:app_user_id` into an `app_user_id` claim on issued id/access tokens; see [[cognito-pre-token-lambda]] |

See [[ADR-0010-cognito-auth]] for the full authentication decision and [[cognito-pre-token-lambda]]
for the custom attribute + Lambda design. Locally, both the App Client and the Pre-Token trigger
are wired around Floci/provider gaps via the awscli-fallback pattern — see
[[awscli-fallback-for-floci]] and [[ADR-0017-floci-local]].

### Secrets & Config

| Resource | Purpose |
|---|---|
| AWS Secret Manager | DB credentials (writer + reader), third-party API keys |
| AWS Parameter Store | Non-sensitive config (feature flags, queue URLs, endpoints) |

See [[ADR-0007-secrets-parameter-store]] for the split rationale and [[secret-rotation]] for
the rotation runbook.

## Cross-cutting rules

- All resources are named with `cloudposse/label/null`; see [[terraform-modules]].
- DB users are created without `DELETE` privilege; row removal goes through soft-delete;
  see [[soft-delete]] and [[ADR-0004-soft-delete-only]].
- Secrets are never embedded in task definition environment variables; they are fetched at
  container start via the ECS secrets injection mechanism.
- Observability (CloudWatch → OpenObserve) applies to all resources; see
  [[ADR-0018-observability-openobserve]] (supersedes [[ADR-0011-observability-signoz]]).

## Related

- [[ADR-0006-read-write-replicas]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0010-cognito-auth]]
- [[ADR-0004-soft-delete-only]]
- [[ADR-0011-observability-signoz]]
- [[ADR-0018-observability-openobserve]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[ADR-0017-floci-local]]
- [[terraform-modules]]
- [[networking]]
- [[soft-delete]]
- [[secret-rotation]]
- [[rds-aurora-engine-switchable-floci]]
- [[two-phase-terraform-apply]]
