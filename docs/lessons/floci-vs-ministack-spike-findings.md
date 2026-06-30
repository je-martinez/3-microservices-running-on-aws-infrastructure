---
title: "Floci vs Ministack spike findings"
type: lesson
area: infra
status: active
created: 2026-06-29
updated: 2026-06-29
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/low
related:
  - "[[ministack-auth-chain-spike-findings]]"
  - "[[ADR-0012-ministack-local]]"
  - "[[2026-06-29-floci-local-emulator-spike-design]]"
---

# Floci vs Ministack spike findings

Empirical A/B findings from the Floci local emulator spike. These are gate-passed facts
recorded for future infra decisions. No migration decision is made here.

> [!note] Spike findings only — no migration decision
> This lesson records what the Floci spike found. ADR-0012 (Ministack for local AWS emulation)
> remains `accepted`. The Floci spike code is left in the working tree, uncommitted, pending the
> user's decision. See [[ADR-0012-ministack-local]].

## Context

The Ministack local setup (documented in [[ministack-auth-chain-spike-findings]]) accumulated a
set of fragile workarounds. Most prominent: a ~150-line `bootstrap.sh` that discovers the Nginx
ECS container IP via `docker inspect` after `terraform apply` and patches the API Gateway
HTTP_PROXY integration URI — with brittle retry loops.

[Floci](https://floci.io/floci/) is an MIT-licensed local AWS emulator (65 services, same
`AWS_ENDPOINT_URL` interface at `:4566`, single-process Quarkus/Java runtime) evaluated as a
possible replacement. The spike validated the **same auth chain** the Ministack spike validated:

```
Client (Bearer JWT)
  └─> API Gateway v2 JWT authorizer → Cognito (Floci)
        └─> ECS Nginx task (on 3mrai-network, reverse proxy)
              └─> spike-backend → HTTP 200 "spike-ok-via-floci"
```

Spike code lives in `infra/environments/local/spike-floci/` and the `floci` service in `docker-compose.yml`.

## Gate result

**PASS** — the full auth chain works on Floci (functional equivalence to Ministack confirmed).

Smoke test results on Floci:

| Request | Result |
|---|---|
| `GET /public` (no auth required) | `200` — body `spike-ok-via-floci` |
| `GET /protected` (no token) | `401` |
| `GET /protected` (valid Bearer token) | `200` — body `spike-ok-via-floci` |

## Comparison table

| Aspect | Ministack | Floci | Notes |
|---|---|---|---|
| Full auth chain works | ✅ PASS | ✅ PASS | Equivalent |
| Image / runtime | `ministackorg/ministack:1.3.69-full` (Python) | `floci/floci:latest` (Quarkus/Java) | — |
| License / telemetry | Proprietary | MIT, no telemetry, no account | Floci advantage |
| Modern AWS provider (v5.100) | ❌ nil-pointer panic | ❌ "Provider produced inconsistent result" on aws_cognito_user_pool_client | Both must pin `= 5.31.0` |
| Separate SG rule resources (`aws_vpc_security_group_ingress_rule` / `egress_rule`) | ❌ crash → inline required | ✅ work | Ministack quirk eliminated on Floci |
| ECS task as real Docker container on compose network | ✅ via `LAMBDA_DOCKER_NETWORK` | ✅ via `FLOCI_SERVICES_ECS_DOCKER_NETWORK=3mrai_3mrai-network` | — |
| Docker embedded DNS by `container_name` (127.0.0.11) | ✅ | ✅ | The ONLY working local service discovery in both |
| Route53 / Cloud Map service discovery (local) | ❌ R53 records do not affect the container resolver | ❌ Cloud Map API exists; Floci docs confirm Route53 is management-plane only (no resolution); ECS tasks not registered in Cloud Map → Docker-native alias is the working substitute | Category limitation — neither AWS-service path backs container DNS |
| `bootstrap.sh` IP patch | ⚠️ required (docker inspect + update-integration) | ✅ eliminated via constant Docker-DNS alias (`nginx-stable`); integration fixed, bootstrap just re-attaches alias — verified across task recreation | See "Killing the IP patch" section below |
| ECS drift on every `terraform apply` | Task stable after apply | ⚠️ Recreates the nginx task each apply (new IP) | Ministack advantage |
| Cognito user pool client apply | ✅ Clean | ❌ Returns `AnalyticsConfiguration:{}` empty block → provider aborts; workaround: `lifecycle { ignore_changes = [analytics_configuration] }` | Ministack advantage |
| API GW v2 local invoke URL | `http://<api-id>.execute-api.localhost:4566` | `http://localhost:4566/restapis/<api-id>/$default/_user_request_/<path>` (LocalStack-style; the execute-api host form hits Floci's S3 handler and returns NoSuchBucket) | Different URL form — runbooks must branch |
| Cognito `iss` claim | `https://cognito-idp.<region>.amazonaws.com/<pool-id>` | `http://localhost:4566/<pool-id>` | Authorizer issuer must match this form on each emulator |
| Service catalogue | SQS, Lambda, ECS, RDS, S3, DocumentDB… | 65 services incl. apigatewayv2, cloudmap, elbv2, eks, servicediscovery | Floci advantage |
| Cognito Lambda triggers (PostConfirmation etc.) | ❌ stored, never invoked | ❌ stored, never invoked | tie — use service-emitted EventBridge event instead |
| EventBridge → Lambda/SQS target delivery | ✅ delivers (verified) | (not retested here) | Floci verified |

## Key findings

- **Route53/Cloud Map cannot resolve container DNS — Docker-native alias is the fix.** Neither
  emulator propagates Route53 or Cloud Map to the container OS resolver; this is a category
  limitation, not a defect in either tool. The only local service discovery that works is Docker
  embedded DNS (`127.0.0.11`). Initially the API Gateway HTTP_PROXY integration still needed a
  post-apply container-IP patch on both emulators (already documented for Ministack in finding #2
  of [[ministack-auth-chain-spike-findings]], confirmed for Floci). A later spike iteration
  **eliminated that patch on Floci** via a stable Docker-DNS alias (`nginx-stable`) — see the
  "Killing the IP patch" section below. The same pattern is portable to Ministack.

- **Floci eliminates the SG-rule-inline workaround.** Separate `aws_vpc_security_group_ingress_rule`
  and `aws_vpc_security_group_egress_rule` resources work without a crash under Floci. The
  inline-block workaround (required on Ministack 1.3.69) is not needed.

- **Floci introduces two new frictions** not present on Ministack:
  1. The Cognito user pool client returns an `AnalyticsConfiguration:{}` empty block on apply,
     causing the AWS provider to abort with "Provider produced inconsistent result". The fix is
     `lifecycle { ignore_changes = [analytics_configuration] }` on the resource.
  2. The ECS nginx task is recreated on every `terraform apply`, producing a new container IP
     each time — meaning the post-apply bootstrap step must re-run after every apply, not only
     after the first.

- **Different invoke URL and `iss` claim.** Floci uses a LocalStack-style URL path
  (`/restapis/<id>/$default/_user_request_/<path>`) rather than the virtual-host form
  (`<id>.execute-api.localhost:4566`). Using the virtual-host form against Floci hits its S3
  handler and returns `NoSuchBucket`. Similarly, Floci's Cognito mints tokens with
  `iss = http://localhost:4566/<pool-id>` (not the AWS-format URL). Both runbooks and smoke
  tests must use emulator-specific values.

- **Provider pin required on both.** AWS provider v5.100 fails on both Ministack (nil-pointer
  panic) and Floci ("Provider produced inconsistent result" on cognito client). Both stacks must
  pin `= 5.31.0` until the upstream issues are resolved.

- **Net: no clear winner.** Floci wins on openness (MIT, no telemetry), separate SG rule
  resources, service breadth (65 services), and now the `bootstrap.sh` IP-patch elimination via
  the stable Docker-DNS alias (portable to Ministack as well, so it is a shared gain, not a
  Floci-exclusive differentiator). Ministack wins on apply stability (ECS task does not drift) and
  clean Cognito client apply. The decision to migrate is deferred — ADR-0012 unchanged.

## Killing the IP patch: stable Docker-DNS alias (mock Route53)

### The problem

Floci launches the nginx ECS task as a Docker container whose name and IP change on every
`terraform apply` — the task is recreated each run. The naive fix (and Ministack's current
`bootstrap.sh`) discovers that volatile IP via `docker inspect` and patches the API Gateway
integration URI after each apply. This is fragile: it mutates Terraform-managed infrastructure
out of band, relies on dynamic data, and must re-run every time the task is recreated.

### Why Route53/Cloud Map cannot solve it

Confirmed: Floci's Route53 is **management-plane only** — its own docs state "actual DNS
resolution is not provided." Creating hosted zones and records does not make those names
resolvable from containers. ECS tasks are not automatically registered in Cloud Map either.
Neither AWS-service path backs container DNS in local emulators. Floci's own docs point to the
answer: for custom hostname resolution to container IPs, use Docker's native networking.

### The solution (verified)

Attach a **constant** Docker-network alias `nginx-stable` (optionally a fixed IP
`192.168.155.20`) to whichever nginx container is currently running, and point the API Gateway
integration at `http://nginx-stable/` permanently in Terraform. Docker embedded DNS
(`127.0.0.11`) resolves the alias from anywhere on the network — including Floci's API GW
container.

Verified: `GET` through API GW → `200` `spike-ok-via-floci`.

Attachment command:

```bash
docker network connect \
  --alias nginx-stable \
  [--ip 192.168.155.20] \
  3mrai_3mrai-network \
  <nginx-container-name>
```

**Results:**

- The integration URI is correct at apply time and **never changes** — no post-apply patch.
- `bootstrap.sh` is reduced to "attach a constant alias": idempotent, no `docker inspect`, no
  dynamic data, no infrastructure mutation.
- **Proven across a task recreation:** `terraform apply` (new task ID + new IP) → integration
  still `http://nginx-stable/` (untouched in state) → `bootstrap.sh` re-attaches alias → gate
  PASS.

### Scope and caveats

> [!note] Portable but not a differentiator
> This alias pattern is portable to Ministack as well — its `bootstrap.sh` does the same IP
> patch today — so it eliminates a **shared pain** but is NOT by itself a Floci-vs-Ministack
> differentiator. It does not remove the underlying ECS task-recreation drift on every apply
> (the task is still recreated on Floci; the alias simply makes that irrelevant to the
> integration). No migration decision is implied; ADR-0012 is unchanged; the spike code remains
> uncommitted.

## Cognito Lambda triggers — not invoked (both emulators)

### The problem

AWS Cognito User Pools support Lambda triggers — PreSignUp, PostConfirmation, PostAuthentication,
PreTokenGeneration, CustomMessage, and others — that fire on sign-up/confirm/auth events. Each
invocation receives an event payload containing `userName`, `userPoolId`,
`request.userAttributes` (including `sub` and `email`), and `callerContext.clientId`.
`PostConfirmation_ConfirmSignUp` is the natural trigger for capturing user data after
registration.

**Neither Ministack nor Floci invokes these triggers.** Both emulators store the `LambdaConfig`
on the user pool — `describe-user-pool` shows `LambdaConfig.PostConfirmation` set — and both let
sign-up and `admin-confirm-sign-up` succeed. However, the configured Lambda is never invoked on
confirmation. Verified by two independent observations:

1. The Lambda function works correctly when invoked directly: it runs, logs the full event
   payload, and returns successfully — proving the function itself is not the issue.
2. Emulator logs show `AdminConfirmSignUp → confirmed` but **no INVOKE** of the trigger Lambda.
   The only invocations observed were explicit manual test invokes. No confirmation-triggered
   invocation appeared in either emulator's log.

This matches the known Ministack note ("Lambda triggers are stored but never invoked") and is
now confirmed to be identical behavior on Floci.

> [!note] Extra Floci observation
> Floci also logged a serialization error when persisting Cognito verification codes:
> `No serializer found for class ... VerificationCode`. This is a minor fidelity bug in Floci
> and is not blocking — sign-up and confirm flows complete despite the error.

### What DOES work (the alternative)

**EventBridge delivers to targets in Floci (verified):** a rule was created with an event pattern,
a Lambda target was added, `PutEvents` was called, and the Lambda was invoked with the full
payload in `event.detail` — including `sub`, `email`, and `userName`. EventBridge → Lambda/SQS
target delivery works in Floci, unlike Cognito triggers.

`cognito-idp ListUsers` is supported on both emulators, so a polling-based fallback is also
possible as a last resort, though it is not event-driven.

### Decision — chosen capture pattern

Because neither emulator fires Cognito Lambda triggers, the `users` service emits a domain event
itself after processing a registration request:

```
PutEvents({
  Source:     "app.users",
  DetailType: "UserRegistered",
  Detail:     { sub, email, ...claims }
})
```

An EventBridge rule routes the event to a target — a Lambda function or the existing
**events-pipeline** SQS queue.

**Why this pattern:**

- It is a legitimate AWS-native pattern: decoupling registration capture from Cognito triggers is
  standard practice in event-driven architectures.
- It works identically in Floci and in real AWS — no per-environment branching is required.
- It reuses the project's existing `events-pipeline` (SQS → Lambda), avoiding new infrastructure.
- It sidesteps the never-invoked-trigger limitation that affects **both** emulators, so it does
  not change or complicate the Floci-vs-Ministack decision.

**Alternatives considered and why secondary:**

| Alternative | Why secondary |
|---|---|
| Capture inline in `users` service DB | Simplest, but not event-driven; other services do not learn of the registration |
| Poll `ListUsers` | Works on both emulators, but laggy and not event-driven |
| Cognito-native EventBridge emission | Not emitted by either emulator; would require per-environment branching |

**Implementation note:** this is recorded as a pattern for the relevant service milestones
(`users` and `events-pipeline`). No service code is written now — the spike stays code-free and
uncommitted.

## Related

- [[ministack-auth-chain-spike-findings]]
- [[ADR-0012-ministack-local]]
- [[2026-06-29-floci-local-emulator-spike-design]]
- [[ADR-0011-observability-signoz]]
