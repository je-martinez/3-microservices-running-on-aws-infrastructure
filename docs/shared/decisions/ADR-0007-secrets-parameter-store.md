---
title: "ADR-0007: Secrets in Secret Manager, Config in Parameter Store"
type: adr
area: shared
status: accepted
id: ADR-0007
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
updated: 2026-07-12
tags: [type/adr, area/shared, status/accepted]
related:
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0012-ministack-local]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0014-env-validation-zod]]"
---

# ADR-0007: Secrets in Secret Manager, Config in Parameter Store

## Context

Credentials (DB passwords, API keys) and non-sensitive configuration (DB hostnames, port numbers, feature flags) have different security requirements and rotation lifecycles. Storing both in the same place complicates access control and rotation.

## Decision

Sensitive credentials are stored in AWS Secrets Manager (with automatic rotation enabled where supported). Non-sensitive configuration is stored in AWS Systems Manager Parameter Store (SecureString where appropriate). Local development syncs both to a `.env` file that is never committed. The `.env` file is a local-only sync artifact.

## Consequences

Access policies can be scoped precisely: services get `secretsmanager:GetSecretValue` only for their own secrets. Rotation of DB credentials does not require application redeployment. All services must include a startup routine to load config from Parameter Store and secrets from Secrets Manager.

> [!warning] Current state (2026-07-12) — not implemented yet
> This ADR records the **intended production decision**; it is not in force today. Verified: there
> is no `aws_secretsmanager_*` and no `aws_ssm_parameter` resource anywhere in `infra/`. In the
> current local environment, configuration comes from `.env` plus Docker Compose environment
> variables. The Users service reads config from `process.env`, validated at startup with Zod (see
> [[ADR-0014-env-validation-zod]]) rather than a Parameter Store fetch. The local application-DB
> password lives in a git-ignored `infra/environments/local/.app-db-secret` file, not in Secrets
> Manager. Adopting Secrets Manager / Parameter Store for real is future work — this ADR stays
> `accepted` as the target design.

## Related

- [[ADR-0006-read-write-replicas]]
- [[ADR-0012-ministack-local]]
- [[ADR-0017-floci-local]]
- [[ADR-0014-env-validation-zod]]
