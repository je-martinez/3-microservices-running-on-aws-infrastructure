---
title: "ADR-0016: Local API Gateway → Nginx ECS reverse proxy (no ALB locally)"
type: adr
area: infra
status: accepted
id: ADR-0016
created: 2026-06-28
updated: 2026-06-28
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/infra, status/accepted]
related:
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0012-ministack-local]]"
  - "[[ministack-auth-chain-spike-findings]]"
  - "[[2026-06-28-users-service-design]]"
---

# ADR-0016: Local API Gateway → Nginx ECS reverse proxy (no ALB locally)

> [!warning] Scope: LOCAL environment only
> This ADR governs **only the local development environment**. It does not supersede [[ADR-0009-apigw-alb-fargate]], which remains the production topology. See the Consequences section.

## Context

The production topology (documented in [[ADR-0009-apigw-alb-fargate]]) routes external traffic through:

```
API Gateway (+ Cognito JWT authorizer) → ALB → ECS Fargate task
```

During the JE-25 auth-chain spike against **Ministack 1.3.69-full**, it was discovered that Ministack's ALB emulator only supports `target_type = lambda`. Attempting to use `target_type = ip` or `target_type = instance` — which are required to front an ECS Fargate task — returns "Target type not supported". An ALB therefore cannot front ECS Fargate tasks locally.

The local environment must still:

- Exercise a real Cognito JWT authorizer on every request.
- Route authenticated traffic to the actual service containers running with Docker Watch (hot-reload on `3mrai_3mrai-network`).
- Remain close enough to the production shape that auth/routing bugs surface locally.

A local substitute for the ALB is needed that satisfies these requirements without the ALB.

## Decision

In the **local environment**, the auth chain is:

```
API Gateway v2 (+ Cognito JWT authorizer)
  │  HTTP_PROXY integration
  ▼
ECS task: Nginx container  (on 3mrai_3mrai-network)
  │  proxy_pass via Docker embedded DNS (127.0.0.11)
  ▼
Target service container  (on 3mrai_3mrai-network)
```

Key decisions within this topology:

1. **No ALB locally.** The ALB hop is skipped entirely. API Gateway integrates directly with an ECS task running Nginx.

2. **Nginx as the local reverse proxy.** An ECS task running Nginx forwards requests to the target service container by its Docker compose service name. Docker embedded DNS (`resolver 127.0.0.11 valid=5s`) handles resolution; Route 53 is not involved.

3. **Nginx config injected via shell `command`.** Because Ministack ECS tasks cannot mount host volumes, the Nginx configuration is injected by embedding it as a shell `command` in the container definition.

4. **Integration URI bootstrapped post-launch.** The Nginx container's IP on `3mrai_3mrai-network` is not known at `terraform apply` time. A local bootstrap script discovers the IP via `docker inspect` and patches the API Gateway integration using:

   ```bash
   aws apigatewayv2 update-integration \
     --api-id <api-id> \
     --integration-id <integration-id> \
     --integration-uri http://<nginx-container-ip>:<port>
   ```

   This step is local-only. Production uses a stable DNS name (service-discovery or ALB DNS) and does not require this bootstrap.

5. **JWT authorizer issuer is the AWS-format URL.** Ministack mints tokens with an AWS-format `iss` claim. The issuer configured on the authorizer must be `https://cognito-idp.us-east-1.amazonaws.com/<pool-id>`, not a localhost endpoint.

The full set of Ministack quirks that constrain this topology (provider pin, security group rules, endpoint declarations, etc.) are recorded in [[ministack-auth-chain-spike-findings]].

## Consequences

### What this enables

- A real Cognito JWT authorizer is active on every local request — auth bugs surface locally.
- Authenticated requests reach the actual service container on the compose network, including Docker Watch hot-reload.
- The topology shape (API GW → proxy → service) is close enough to production to catch integration issues before deployment.

### Constraints and trade-offs

- **Nginx hop is local-only.** The production path goes through an ALB; local goes through Nginx. Nginx-specific configuration (timeouts, headers) must be kept minimal and intentional so it does not mask production issues.
- **Integration URI bootstrap step** adds operational friction for local environment setup. It must be scripted and documented in the local dev runbook.
- **Provider must stay pinned to `= 5.31.0`.** Upgrading the AWS Terraform provider requires re-validating all Ministack interactions.
- **Ministack ALB constraint is the root cause.** If a future Ministack release adds `ip`/`instance` target type support, the ALB can be reintroduced locally and this ADR can be superseded in favor of a topology closer to production.

### Production is NOT affected

**[[ADR-0009-apigw-alb-fargate]] is NOT superseded.** The production topology (API GW → ALB → Fargate) remains the target architecture and is deferred pending the current Users milestone's deployment phase. This ADR only describes how the local environment bridges the gap until then.

## Related

- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0012-ministack-local]]
- [[ministack-auth-chain-spike-findings]]
- [[2026-06-28-users-service-design]]
