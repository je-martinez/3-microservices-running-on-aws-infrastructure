---
title: "ADR-0010: AWS Cognito for Authentication and Authorization"
type: adr
area: shared
status: accepted
id: ADR-0010
created: 2026-06-26
updated: 2026-06-26
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related: []
---

# ADR-0010: AWS Cognito for Authentication and Authorization

## Context

The system needs a managed identity provider that handles user registration, login, token issuance, and authorisation without the overhead of building and operating a custom auth service. Integration with API Gateway must be native to avoid per-service auth logic.

## Decision

AWS Cognito User Pools handle user registration and authentication. JWT tokens issued by Cognito are validated by an API Gateway Cognito Authoriser before any request reaches a service. Services trust the claims in the forwarded JWT — they do not re-validate tokens independently.

## Consequences

Auth complexity is offloaded to a managed AWS service. Services are stateless with respect to session management. Any Cognito User Pool configuration changes (password policy, MFA) affect all services simultaneously and must be coordinated through Terraform.

## Related

- [[ADR-0009-apigw-alb-fargate]]
