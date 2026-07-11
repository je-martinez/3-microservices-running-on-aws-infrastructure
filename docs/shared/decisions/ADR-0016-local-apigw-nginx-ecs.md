---
title: "ADR-0016: Local API Gateway → Nginx ECS reverse proxy (no ALB locally)"
type: adr
area: infra
status: accepted
id: ADR-0016
created: 2026-06-28
updated: 2026-07-11
deciders: [Jose E. Martinez]
supersedes: null
superseded-by: null
tags: [type/adr, area/infra, status/accepted]
related:
  - "[[ADR-0009-apigw-alb-fargate]]"
  - "[[ADR-0012-ministack-local]]"
  - "[[ministack-auth-chain-spike-findings]]"
  - "[[2026-06-28-users-service-design]]"
  - "[[ADR-0017-floci-local]]"
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

> [!info] 2026-07-11 — this was a Ministack limitation, not a durable one
> This ALB constraint was specific to **Ministack**. Since the project migrated to **Floci** ([[ADR-0017-floci-local]]), live POCs verified `ip`-type target groups + VPC Link v2 **do** work. See the [[#Update (2026-07-11) Floci capabilities re-verified|Update section]] below — the decision to skip the ALB locally still stands, but this specific rationale no longer applies as-is.

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
   > [!info] 2026-07-11 — superseded by a verified Floci capability
   > Floci **does** support ECS host volumes (`volume { host_path = ... }` + container `mountPoints`), verified live this session. The command-embedded `printf` approach described here has since been replaced by checked-in config files bind-mounted into the container — see the [[#Update (2026-07-11) Floci capabilities re-verified|Update section]] below.

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
  > [!success] 2026-07-11 — this condition is now met, on Floci
  > The project migrated to Floci ([[ADR-0017-floci-local]]), and this session verified `ip`-type target groups + VPC Link v2 work there. Reintroducing the ALB locally is now a viable option rather than a blocker — see the Update section below. It has not been implemented; nginx is still in use.

### Update (2026-07-11): Floci capabilities re-verified

> [!info] Status: informational update, decision unchanged
> This section records findings **empirically verified live** during a Floci capability spike this session. They correct several assumptions this ADR inherited from Ministack. The core local decision (nginx, no ALB) still stands for now — see "What still holds" below — but the *reasons* have narrowed considerably.

Since this ADR was accepted, the project migrated the local emulator from Ministack to **Floci** ([[ADR-0017-floci-local]]). Several Ministack-era limitations cited above do not hold on Floci:

1. **Floci supports ECS host volumes.** A task definition with `volume { host_path = ... }` plus a container `mountPoints` entry successfully bind-mounted a host directory into the running container (verified: file contents were readable inside the container). This contradicts the "Ministack ECS cannot mount host volumes" rationale in Decision item 3.
   **Consequence already applied:** the local nginx config (`auth.js` + `nginx.conf`) is now shipped as checked-in files under `infra/modules/compute/nginx/`, bind-mounted at `/etc/nginx/mounted/`, replacing the old command-embedded `printf` approach.

2. **Floci supports ALB (ELBv2) + target groups with `target_type = ip`, and VPC Link v2.** Verified: a real ALB, an `ip` target group, a listener, and a VPC Link v2 were created; an API Gateway HTTP integration via VPC Link → ALB → the users container returned `200` for `/v1/health` with the path preserved. This contradicts the core rationale in Context/Decision that `ip`/`instance` target types are unsupported locally — that was a **Ministack** limitation, not a Floci one. The ALB hop this ADR skips locally could now be reintroduced on Floci to match the production topology of [[ADR-0009-apigw-alb-fargate]]. **This has not been implemented** — nginx remains in use — but it is now a viable future direction rather than a blocker.

3. **Cognito Pre-Token-Generation V2 Lambda triggers DO fire on Floci.** Verified: a Pre-Token-Generation V2 Lambda added a custom claim that appeared in both the id and access tokens. The blanket "Cognito Lambda triggers never invoked" assumption (carried over from the Floci skill / earlier notes) is only true for PostConfirmation/PreSignUp — **not** for Pre-Token-Generation. This is informational; the project still uses nginx+njs for header injection because of the limitation in item 4.

4. **What still holds on Floci (why nginx+njs remains the mechanism for auth-identity):** Floci's API Gateway does **not** execute a claim→header mapping from authorizer/JWT claims into a request header at request time. Verified across 6 configurations (v1/v2 parameter mapping, Lambda-authorizer context, JWT-claims mapping, VPC-Link+ALB, REST v1) — Floci accepts the config in all cases but never applies it. So injecting the Cognito `sub` into the `x-user-id` header locally is done with **nginx + njs** (decodes the JWT, injects the header). The API Gateway `request_parameters` claim→header mapping remains correct for real AWS (production) but is a no-op in Floci.
   Also verified: Floci does not validate refresh tokens — a garbage refresh token returns `200` — so the `/v1/users/refresh` `401` path is only exercisable against real AWS or in unit tests, not locally end-to-end.

**Net effect on this ADR's rationale:** it is no longer accurate to say "Floci/the local emulator can't do ALB/host volumes" (items 1–2 disprove that on Floci). The accurate framing is: the local topology **hasn't been migrated** to use the ALB yet, and the one Floci limitation that specifically motivates keeping nginx+njs is the claim→header mapping gap in item 4. This ADR's status remains **accepted**; a future ADR could supersede it if the ALB topology is adopted locally.

### Production is NOT affected

**[[ADR-0009-apigw-alb-fargate]] is NOT superseded.** The production topology (API GW → ALB → Fargate) remains the target architecture and is deferred pending the current Users milestone's deployment phase. This ADR only describes how the local environment bridges the gap until then.

## Related

- [[ADR-0009-apigw-alb-fargate]]
- [[ADR-0012-ministack-local]]
- [[ministack-auth-chain-spike-findings]]
- [[2026-06-28-users-service-design]]
- [[ADR-0017-floci-local]]
