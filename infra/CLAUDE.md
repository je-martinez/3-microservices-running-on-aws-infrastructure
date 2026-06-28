# CLAUDE.md — infrastructure

Nested project memory for the **Terraform/AWS infrastructure**. Source of truth
for the infra stack and conventions. The global `infra-impl` agent reads this
first, every time. Cross-cutting rules are **referenced**, never duplicated.

## 1. Stack & versions
- IaC: Terraform (own modules; no flat resources).
- Naming: cloudposse/label/null module.
- Cloud: AWS (ECS Fargate + ECR, SQS + Lambda, API Gateway + ALB, Cognito, Route 53, Secrets Manager, Parameter Store, DocumentDB, Aurora Postgres/MySQL).
- Local: Ministack.

## 2. Commands
- Init: `terraform init`
- Validate: `terraform validate`
- Format: `terraform fmt -recursive`
- Plan: `terraform plan`
- Apply: `terraform apply`

> These run per environment under `environments/<env>/`; the configurations
> themselves are created in the infrastructure implementation milestone.

## 3. Folder structure
```
infra/
├── modules/{label,networking,database,messaging,compute,api-gateway}/
└── environments/{local,production}/
```

## 4. Conventions (referenced, never duplicated)
- cloudposse/label naming: [../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md](../docs/shared/decisions/ADR-0001-terraform-cloudposse-naming.md)
- Read/write replicas: [../docs/shared/decisions/ADR-0006-read-write-replicas.md](../docs/shared/decisions/ADR-0006-read-write-replicas.md)
- Secrets & Parameter Store: [../docs/shared/decisions/ADR-0007-secrets-parameter-store.md](../docs/shared/decisions/ADR-0007-secrets-parameter-store.md)
- API GW → ALB → Fargate: [../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md](../docs/shared/decisions/ADR-0009-apigw-alb-fargate.md)
- Cognito auth: [../docs/shared/decisions/ADR-0010-cognito-auth.md](../docs/shared/decisions/ADR-0010-cognito-auth.md)
- Observability (SigNoz): [../docs/shared/decisions/ADR-0011-observability-signoz.md](../docs/shared/decisions/ADR-0011-observability-signoz.md)
- Ministack local: [../docs/shared/decisions/ADR-0012-ministack-local.md](../docs/shared/decisions/ADR-0012-ministack-local.md)

## 5. Agent rules
- Converse with the user in **Spanish**; write config and comments in **English**.
- `infra-impl` writes **only Terraform/config** — never runs git or touches Linear.
- Leave finished work in the working tree for `github-ops` to commit.
- Stay within the single task handed to you (YAGNI).

## 6. Design reference
- Infra specs (vault): [../docs/infrastructure/specs/](../docs/infrastructure/specs/)
- Scaffold design: [../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md](../docs/superpowers/specs/2026-06-28-services-infra-scaffold-design.md)
