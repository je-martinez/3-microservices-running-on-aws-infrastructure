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
updated: 2026-07-12
tags: [type/adr, area/shared, status/accepted]
related:
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0017-floci-local]]"
  - "[[cognito-pre-token-lambda]]"
---

# ADR-0010: AWS Cognito for Authentication and Authorization

## Context

The system needs a managed identity provider that handles user registration, login, token issuance, and authorisation without the overhead of building and operating a custom auth service. Integration with API Gateway must be native to avoid per-service auth logic.

## Decision

AWS Cognito User Pools handle user registration and authentication. JWT tokens issued by Cognito are validated by an API Gateway Cognito Authoriser before any request reaches a service. Services trust the claims in the forwarded JWT — they do not re-validate tokens independently.

## Consequences

Auth complexity is offloaded to a managed AWS service. Services are stateless with respect to session management. Any Cognito User Pool configuration changes (password policy, MFA) affect all services simultaneously and must be coordinated through Terraform.

> [!warning] Local deviation (2026-07-12) — Floci never maps claims to a header
> "Services trust the forwarded JWT claims" is the production intent, but locally **Floci's API
> Gateway never maps authorizer/JWT claims into a request header** — verified across 6 different
> configurations (see [[ADR-0017-floci-local]]). This is exactly why the local stack injects
> identity itself: an Nginx ECS reverse proxy running **nginx+njs** decodes the JWT and sets the
> `x-user-id` header before forwarding to the service (see [[ADR-0016-local-apigw-nginx-ecs]]).
> Services still don't re-validate the token; they just receive their claim via a different local
> mechanism than production. Also see [[cognito-pre-token-lambda]] for the `custom:app_user_id`
> claim, added via a Pre-Token-Generation V2 Lambda trigger (the repo's first Lambda) so
> `app_user_id` is available directly on the token without an extra lookup.

## Related

- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0017-floci-local]]
- [[cognito-pre-token-lambda]]
