---
title: "ADR-0017: Floci for Local AWS Emulation"
type: adr
area: shared
status: accepted
id: ADR-0017
created: 2026-06-29
updated: 2026-07-12
deciders: [Jose E. Martinez]
supersedes: ADR-0012
superseded-by: null
tags: [type/adr, area/shared, status/accepted]
related:
  - "[[ADR-0012-ministack-local]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[2026-06-29-floci-local-emulator-spike-design]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[cognito-pre-token-lambda]]"
---

# ADR-0017: Floci for Local AWS Emulation

## Context

Local development previously used Ministack as the local AWS emulator ([[ADR-0012-ministack-local]]). The Ministack Users-chain spike accumulated a stack of fragile workarounds: the AWS provider had to be pinned at `= 5.31.0`, API Gateway integration URIs required a post-apply `bootstrap.sh` script that ran `docker inspect` to discover the Nginx ECS container IP and patched the integration after apply, and separate security-group rule resources (`aws_vpc_security_group_*_rule`) caused crashes requiring inline-only SG rules.

A focused spike evaluated [Floci](https://floci.io/floci/) — an MIT-licensed local AWS emulator (65 services, single port `:4566`, same `AWS_ENDPOINT_URL` interface) — against the real local auth chain:

> **Cognito JWT → API GW v2 JWT authorizer → ECS Nginx (reverse proxy) → spike-backend**

The spike findings ([[floci-vs-ministack-spike-findings]]) and spike design ([[2026-06-29-floci-local-emulator-spike-design]]) are the empirical basis for this decision. The spike returned a **gate PASS**: `401` without a token and `200` with a valid Cognito JWT, with the body `spike-ok-via-floci`.

## Decision

Adopt **Floci** as the local AWS emulator, superseding Ministack ([[ADR-0012-ministack-local]]).

Floci was chosen for the following reasons:

- **Gate PASS** on the real local auth chain (the minimum success criterion was met).
- **MIT-licensed** with no telemetry and no account requirement.
- **Supports separate `aws_vpc_security_group_*_rule` resources**, removing the inline-SG workaround.
- **Docker-DNS-alias pattern** (`FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai-network`) lets ECS containers resolve compose services by `container_name`, eliminating the fragile IP-patch step performed by `bootstrap.sh`.
- **Single-port `:4566` interface** identical to LocalStack — no SDK changes required beyond `AWS_ENDPOINT_URL`.

The `floci` compose service is added to the root `docker-compose.yml`.

> [!note] Superseded by what actually shipped
> This paragraph originally said Ministack would be kept commented out as a fallback and that the reference implementation was the `infra/environments/local/spike-floci/` spike. Neither is true any more: **Ministack has been removed** from `docker-compose.yml`, and the **spike stacks were retired**. The reference implementation is `infra/environments/local/` itself — see the Consequences below.

## Consequences

The following Floci-specific quirks are known from the spike and later verified live work, and **must be accounted for** in all infra work targeting the local environment:

- **AWS provider pinned `= 5.31.0`** — the modern provider causes nil-pointer panics on Floci 1.x; the pin is required until Floci resolves this upstream. This pin has a second, later-discovered consequence: at `= 5.31.0` the `aws_cognito_user_pool.lambda_config` block has **no `pre_token_generation_config` sub-block**, so a Pre-Token-Generation **V2** trigger cannot be declared natively at all — see the awscli-fallback bullet below.
- **`aws_cognito_user_pool_client` cannot be created by the native resource against Floci at all — `lifecycle.ignore_changes` does NOT fix this.** Floci's CREATE response for the client returns an empty `AnalyticsConfiguration` (and `RefreshTokenRotation`) struct. The AWS provider's SDKv2 **post-apply consistency check** reads that empty struct as "block count changed from 0 to 1" and **aborts the apply at resource creation itself** — before any plan-diff is even computed. `lifecycle { ignore_changes = [analytics_configuration] }` only suppresses diffs *between two plans*; it cannot suppress the provider's internal Create-response validation, so it does **not** prevent the abort. That `ignore_changes` lifecycle block is kept in `infra/modules/cognito/main.tf` for the native resource, but it only takes effect when `manage_client_via_provider = true` (production/Ministack) — it is inert as a Floci fix. On Floci (`manage_client_via_provider = false`), the native resource is **bypassed entirely**: `terraform_data.client_via_cli` runs `infra/modules/cognito/scripts/create-user-pool-client.sh`, an idempotent AWS CLI call outside Terraform's resource lifecycle (so the SDKv2 consistency check never runs), writing the resulting client id to a JSON file that `data.local_file` reads back into Terraform state. See [[awscli-fallback-for-floci]] for the general pattern (this is one of its two verified instances) and the long comment above `aws_cognito_user_pool_client` in `infra/modules/cognito/main.tf` for the full mechanics.
- **Floci's API Gateway never maps JWT/authorizer claims into a request header — verified across 6 configurations.** v1/v2 parameter mapping, Lambda-authorizer context, JWT-claims mapping, VPC-Link+ALB, and REST v1 were all tried; Floci accepts the `request_parameters` claim→header config in every case but never applies it at request time. This is **why** the local stack injects `x-user-id` via **nginx + njs** (decoding the JWT and setting the header itself) instead of relying on API Gateway to do it — see [[ADR-0016-local-apigw-nginx-ecs]] (the mapping remains correct configuration for real AWS/production; it is a Floci-only no-op).
- **API GW v2 invoke URL is LocalStack-style** — format is `/restapis/<id>/$default/_user_request_/<path>`; smoke tests and curl commands must use this form.
- **Cognito `iss` claim = `http://localhost:4566/<pool-id>`** — JWT authorizer config and any service-side token validation must use this issuer, not a real AWS Cognito URL.
- **Route53/Cloud Map do not back DNS resolution inside Floci** — use Docker DNS via `container_name` (compose services) or `FLOCI_SERVICES_ECS_DOCKER_NETWORK` (ECS tasks on the compose network). Cloud Map resources can still be declared in Terraform for parity; they just do not drive name resolution.
- **Cognito Lambda triggers: narrower than "never invoked".** PostConfirmation and PreSignUp do **not** fire on Floci. But **Pre-Token-Generation V2 triggers DO fire** — verified live: a Pre-Token-Generation V2 Lambda added a custom claim (`app_user_id`, sourced from `custom:app_user_id`) that appeared in both the id and access tokens. This is the mechanism the repo now ships (the repo's first Lambda) — see [[cognito-pre-token-lambda]]. Because the pinned provider (`= 5.31.0`, see above) cannot declare the V2 trigger natively, it is wired the same awscli-fallback way as the app client: `terraform_data.pre_token_trigger` runs `infra/modules/cognito/scripts/set-pre-token-trigger.sh`, a settings-preserving `update-user-pool` call (Cognito's `UpdateUserPool` is a full-resource PUT, so the script first reads and re-passes every other pool setting to avoid resetting them). See [[awscli-fallback-for-floci]] for the pattern and [[cognito-pre-token-lambda]] for the full design.

This decision migrated `infra/environments/local/` to compose the real Terraform modules (`infra/modules/{label,networking,compute,api-gateway,cognito,rds-aurora}`) directly — this is **done**, not follow-up work. The earlier spike stack `infra/environments/local/spike-floci/` has been **deleted**; it is no longer the reference implementation. The `floci` skill (`.claude/skills/floci/`) carries these quirks for the `infra-impl` agent.

> [!note] Related convention
> The [[ADR-0016-local-apigw-nginx-ecs]] decision (Nginx ECS reverse proxy pattern) remains in effect — the Nginx approach was validated in the Floci spike and is unchanged. Its "Update (2026-07-11)" section holds the live-verified findings this ADR's Consequences section leans on.

## Related

- [[ADR-0012-ministack-local]]
- [[floci-vs-ministack-spike-findings]]
- [[2026-06-29-floci-local-emulator-spike-design]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0010-cognito-auth]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[awscli-fallback-for-floci]]
- [[cognito-pre-token-lambda]]
