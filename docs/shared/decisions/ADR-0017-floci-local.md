---
title: "ADR-0017: Floci for Local AWS Emulation"
type: adr
area: shared
status: accepted
id: ADR-0017
created: 2026-06-29
updated: 2026-07-09
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

The `floci` compose service is added to the root `docker-compose.yml`. Ministack is kept **commented out** (not deleted) as a documented fallback. The reference implementation is `infra/environments/local/spike-floci/`.

## Consequences

The following Floci-specific quirks are known from the spike and **must be accounted for** in all infra work targeting the local environment:

- **AWS provider pinned `= 5.31.0`** — the modern provider causes nil-pointer panics on Floci 1.x; the pin is required until Floci resolves this upstream.
- **`aws_cognito_user_pool_client` requires `lifecycle { ignore_changes = [analytics_configuration] }`** — Floci returns a null field that Terraform treats as a diff on every plan.
- **API GW v2 invoke URL is LocalStack-style** — format is `/restapis/<id>/$default/_user_request_/<path>`; smoke tests and curl commands must use this form.
- **Cognito `iss` claim = `http://localhost:4566/<pool-id>`** — JWT authorizer config and any service-side token validation must use this issuer, not a real AWS Cognito URL.
- **Route53/Cloud Map do not back DNS resolution inside Floci** — use Docker DNS via `container_name` (compose services) or `FLOCI_SERVICES_ECS_DOCKER_NETWORK` (ECS tasks on the compose network). Cloud Map resources can still be declared in Terraform for parity; they just do not drive name resolution.
- **Cognito Lambda triggers are stored but never invoked** — Floci accepts the trigger configuration but does not fire the Lambda on sign-up/sign-in events. Capture user-registration data via a service-emitted EventBridge event instead; EventBridge delivery to targets works correctly in Floci.

This decision does **not** itself migrate `infra/environments/local/` — that is follow-up work. The spike stack `infra/environments/local/spike-floci/` is the reference implementation. The `floci` skill (`.claude/skills/floci/`) carries these quirks for the `infra-impl` agent.

> [!note] Related convention
> The [[ADR-0016-local-apigw-nginx-ecs]] decision (Nginx ECS reverse proxy pattern) remains in effect — the Nginx approach was validated in the Floci spike and is unchanged.

## Related

- [[ADR-0012-ministack-local]]
- [[floci-vs-ministack-spike-findings]]
- [[2026-06-29-floci-local-emulator-spike-design]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[ADR-0010-cognito-auth]]
- [[floci-storage-modes-and-tmp-corruption]]
