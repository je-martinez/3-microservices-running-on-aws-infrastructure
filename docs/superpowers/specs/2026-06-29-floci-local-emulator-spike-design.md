---
title: Floci Local Emulator Spike + infra-impl Skill — Design
type: spec
area: infra
status: accepted
created: 2026-06-29
updated: 2026-06-29
tags: [type/spec, area/infra, status/accepted]
related:
  - "[[ADR-0012-ministack-local]]"
  - "[[2026-06-28-services-infra-scaffold-design]]"
  - "[[ministack-auth-chain-spike-findings]]"
---

# Floci Local Emulator Spike + infra-impl Skill — Design

## Context

Local development runs against **Ministack** (local AWS emulator, [[ADR-0012-ministack-local]]).
It works, but the Users-chain spike accumulated a stack of fragile workarounds:

- AWS provider **pinned to `5.31.0`** (v5.100 nil-pointer-panics Ministack 1.3.69).
- **No ALB `ip` target** → an Nginx ECS task was introduced as a compose-network-aware
  reverse proxy.
- The Nginx container IP is **unknown at apply time** → a ~150-line `bootstrap.sh` does
  `docker inspect` + `aws apigatewayv2 update-integration` to patch the API GW integration
  URI post-apply, with brittle retry loops.
- **Inline security-group rules** required (`aws_vpc_security_group_*_rule` crashes Ministack).
- **No writer→reader replication** (reader URL patched to point at the writer).

[Floci](https://floci.io/floci/) is an MIT-licensed local AWS emulator (65 services, single
port `:4566`, same `AWS_ENDPOINT_URL` interface, init hooks, configurable ECS Docker network).
We want to know — empirically — whether Floci runs our **real local auth chain** and lets us
**delete the fragile workarounds** (especially `bootstrap.sh`), before committing to any migration.

## Goal

Validate Floci against the **same chain** the Ministack spike validated:

> **Cognito JWT → API GW v2 JWT authorizer → ECS Nginx (reverse proxy) → spike-backend**

Run it **A/B, in parallel, with zero risk** to existing work. Ministack has been torn down
(both `local` and `local/spike` stacks destroyed, `docker compose down`) so Floci can take
`:4566` cleanly; the `ministack` compose service is commented out, not deleted.

The spike is a **hard gate**: PASS → strong evidence to migrate (decided later, with evidence);
FAIL → Ministack stays, and we document why.

## Non-goals (YAGNI)

- No Aurora/RDS in the spike (it validates the auth chain, not the DB — neither did the
  Ministack spike).
- No real `users`/`orders`/`tracking`/`events-pipeline` services — only the auth chain.
- **No ADR changes.** ADR-0012 stays `accepted`; no new Floci ADR is written. The migration
  decision is a separate, later step taken only if the spike confirms it.
- No changes to the existing `spike/` (Ministack) or `local/` Terraform — they are left intact
  (their state is already empty after teardown).

> [!success] Decision made
> The spike passed and the migration decision has been taken: Floci is adopted as the local AWS emulator. See [[ADR-0017-floci-local]].

## Architecture

```
curl GET /protected
  └─> API Gateway v2 HTTP API (Floci, :4566)
        └─> JWT authorizer (Cognito on Floci)
              ├─ 401: missing / invalid token
              └─> ECS Nginx task (container on 3mrai-network)
                    └─> proxy_pass http://spike-backend:8080  (Docker DNS via container_name)
                          └─> spike-backend → HTTP 200 "spike-ok-via-floci"
```

### DNS enforcing policy

Per user decision, **enforce DNS service discovery (Route53 / Cloud Map) on every resource
that can use it inside Floci**, replacing IP discovery via `docker inspect`. For images that
run **outside** Floci (the compose services: `spike-backend`, later `users`, …), resolve them
by their **`container_name`** via Docker DNS — Floci joins its ECS containers to the compose
network via `FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai-network`.

**Strategy: Route53/Cloud Map-first with documented fallback.** The ideal (DNS everywhere)
is itself one of the things the spike validates. The spike attempts the Cloud Map/Route53
path first; if Floci does not support a piece, it falls back to the known pattern
(IP/`container_name`) **and records the gap as a finding** — without blocking the spike.

## Components

All new, in parallel:

```
docker-compose.yml                          # EDIT: comment out `ministack` service;
                                            #   `floci` + `spike-backend` services added here
                                            #   (below the commented-out ministack block).
                                            #   NOTE: the originally planned docker-compose.floci.yml
                                            #   overlay was consolidated into this single file.
                                            #   Run with: docker compose up -d floci spike-backend
infra/environments/local/spike-floci/       # NEW Terraform stack (adapted from spike/)
  ├── providers.tf                          #   modern AWS provider (no 5.31.0 pin), :4566
  ├── terraform.tf                          #   required_providers
  ├── main.tf                               #   cognito + networking + ecs nginx
  │                                         #     + cloud map/route53 + api-gw
  ├── variables.tf
  ├── outputs.tf
  ├── README.md                             #   topology, Floci quirks, how to run, FINDINGS
  └── smoke-test.sh                          #   401/200 chain + DNS verification
```

| Resource | Purpose | Difference vs Ministack spike |
|---|---|---|
| Cognito user pool + client | Issues JWTs for the authorizer | same |
| VPC / subnets / SG | `awsvpc` substrate | same (test whether SG-inline workaround is still needed) |
| ECS cluster + task `nginx` | Reverse proxy to `spike-backend`; config via `command` | same pattern |
| **Cloud Map namespace + service** | **Stable DNS for the Nginx ECS task** | **NEW — replaces `docker inspect`** |
| API GW v2 + JWT authorizer + integration | Entry point; `/protected` (JWT), `/public` (open) | integration URI = Cloud Map name, not IP |
| `spike-backend` (compose) | `http-echo` → `spike-ok-via-floci` | resolved by `container_name` |

## Data flow & the `bootstrap.sh` replacement

The Ministack spike needed `bootstrap.sh` to discover the Nginx IP and patch the API GW
integration. **The primary objective is to eliminate it.**

```
terraform apply
  ├─ ECS service `nginx` registers in Cloud Map (e.g. nginx.spike.local)
  ├─ API GW integration URI = http://nginx.spike.local/   (stable, known at apply time)
  └─ (no post-apply step — no docker inspect, no patch)

Floci init hook (ready.d/) — optional:
  └─ create the Cognito test user (what the smoke-test did by hand)

smoke-test.sh
  ├─ GET /protected (no token)        → 401
  ├─ authenticate against Cognito      → IdToken
  └─ GET /protected (Bearer token)     → 200 "spike-ok-via-floci"
```

### Empirical unknowns (tested in this order)

1. Does Floci's ECS service **register in Cloud Map** and does the name resolve in-network?
   → if not, fall back to IP discovery.
2. Does Floci's API GW v2 accept a **Cloud Map DNS name** as `IntegrationUri` and resolve it
   at runtime? → if not, fall back to IP (documented as a Floci limitation).
3. Does the ECS Nginx container resolve `spike-backend` by **`container_name`** via Docker DNS
   on `3mrai-network`? → Ministack did this; we expect Floci to as well.

## Quirk handling (eliminate vs keep as safety net)

| Ministack quirk | Floci hypothesis | Spike strategy |
|---|---|---|
| Provider pin `5.31.0` | Floci tolerates a modern provider | Start unpinned; if it crashes, pin + document |
| Inline SG rules required | Floci tolerates separate `*_rule` resources | Try separate; fall back to inline |
| `skip_requesting_account_id=true` | Same (LocalStack-compat) | Keep |
| API GW local URL `<id>.execute-api.localhost:4566` | Same pattern | Keep |
| No ALB `ip` target → Nginx ECS | Floci ELBv2 may support `ip` | Keep Nginx; note if ALB+ip works as a future improvement |
| `bootstrap.sh` (docker inspect + patch) | Cloud Map eliminates it | **Primary target to remove** |

## Error handling & success criteria

The smoke test keeps the current contract: each step validates and fails with a clear message
(no silent loops); it prints a PASS/FAIL table and a **Floci-vs-Ministack findings summary**
(which quirk was removed, which persists).

**GATE VERDICT:**

- **PASS (minimum):** `401` without token + `200` with token + body `spike-ok-via-floci`.
  Floci is functionally equivalent to Ministack for the auth chain.
- **PASS (ideal):** the above **+ no `bootstrap.sh`** (Cloud Map resolves the integration).
  Floci is *better*.
- **FAIL:** Floci cannot run the chain even with fallbacks → Ministack stays; document why.

## The `floci` skill (knowledge layer for infra-impl)

Written **after** the spike, fully verified (no provisional content).

```
.claude/skills/floci/
  ├── SKILL.md              # what/when, base setup, essential config, verified quirks,
  │                         #   service index, links to official docs
  └── references/
      └── services.md       # service → official doc URL (63 slugs) + "used in 3MRAI"
                            #   column + troubleshooting notes per service page
```

- **`SKILL.md`**: frontmatter `name: floci` + a `description:` with triggers (Floci, local AWS
  emulator, `:4566`, `AWS_ENDPOINT_URL`, local dev infra); what/when; base setup (4 env vars,
  `floci/floci:latest` / `latest-compat`); essential config found relevant
  (`FLOCI_SERVICES_ECS_DOCKER_NETWORK`, `FLOCI_STORAGE_MODE`, init hooks `ready.d/`,
  `FLOCI_SERVICES_ECS_MOCK`); **quirks verified in 3MRAI** (filled from spike findings);
  service index → `references/services.md`; official docs links.
- **`references/services.md`**: table of the **63 services**, each linking
  `https://floci.io/floci/services/<slug>/`, marking those 3MRAI uses (ecs, elb, api-gateway,
  cognito, rds, docdb, sqs, lambda, secretsmanager, ssm, iam, sts, cloudwatch/logs, route53,
  cloudmap, …) with a troubleshooting note where the service page has one (e.g. ECS mock mode,
  ELBv2 target types).
- **Preload in `infra-impl`**: add `floci` to the skills the `infra-impl` agent loads
  (`.claude/agents/infra-impl.md`), analogous to how `obsidian-vault` preloads the Obsidian skills.

## Related

- [[ADR-0012-ministack-local]]
- [[ADR-0017-floci-local]]
- [[floci-vs-ministack-spike-findings]]
- [[2026-06-28-services-infra-scaffold-design]]
- [[ministack-auth-chain-spike-findings]]
