---
title: Terraform Modules
type: spec
area: infra
status: active
created: 2026-06-26
updated: 2026-09-15
tags: [type/spec, area/infra, status/active]
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[floci-sns-fanout-support]]"
  - ADR-0001-terraform-cloudposse-naming
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev-floci]]"
  - "[[cognito-pre-token-lambda]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[rds-aurora-engine-switchable-floci]]"
  - "[[two-phase-terraform-apply]]"
  - "[[terraform-remote-state-backend]]"
  - "[[local-gateway-per-route-integrations]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
  - "[[redis-elasticache-replication-group-floci]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
---

# Terraform Modules

## Summary

This spec describes the custom Terraform module structure used to provision the 3MRAI AWS
infrastructure. All modules follow the `cloudposse/label/null` naming convention, enforced
globally via [[ADR-0001-terraform-cloudposse-naming]].

## Stack & Data Store

- **IaC tool:** Terraform (>= 1.7).
- **State backend:** **local** (`terraform.tfstate` on disk under each environment directory) —
  there is no S3/DynamoDB remote-state backend configured today. `infra/environments/local/`
  keeps `terraform.tfstate` in-tree.
- **Module registry:** private, co-located under `infra/modules/`.
- **Naming root:** `cloudposse/label/null` — every resource receives a deterministic name
  derived from `namespace`, `environment`, `stage`, `name`, and optional `attributes`.
- **Environments:** `infra/environments/{local,production}` — not `dev`/`staging`/`prod`. The
  `local` environment targets Floci ([[ADR-0017-floci-local]]; bootstrap flow: [[local-dev-floci]]).

## Module Inventory

The real module inventory under `infra/modules/`:

| Module path | Responsibility |
|---|---|
| `infra/modules/label` | `cloudposse/label` wrapper providing the naming context |
| `infra/modules/networking` | VPC, subnets, security group |
| `infra/modules/compute` | nginx on ECS — the local reverse proxy that injects `x-user-id` via njs (see [[ADR-0016-local-apigw-nginx-ecs]]) |
| `infra/modules/api-gateway` | API Gateway v2, per-route `HTTP_PROXY` integrations, JWT authorizer |
| `infra/modules/cognito` | Cognito User Pool (+ `custom:app_user_id` attribute), App Client, and the repo's first Lambda (Pre-Token-Generation V2 — see [[cognito-pre-token-lambda]]) |
| `infra/modules/rds-aurora` | Aurora cluster (writer + reader endpoints), engine-agnostic — serves both Aurora Postgres (users) and Aurora MySQL (orders, tracking); see [[rds-aurora-engine-switchable-floci]] |
| `infra/modules/docdb` | DocumentDB cluster + instance + subnet group, plus the awscli fallback for Floci (`manage_cluster_via_provider = false`); backs the events-pipeline's event store — see [[events-pipeline-design]] |
| `infra/modules/messaging` | SQS main queue + DLQ + redrive-allow policy for the events-pipeline, plus (2026-09-15) the SNS fan-out topic and the notifications queue/subscriptions — see [[events-pipeline-design]] and [SNS fan-out and the notifications queue](#sns-fan-out-and-the-notifications-queue-2026-09-15) below |
| `infra/modules/lambda` | packages and deploys the events-pipeline Lambda (IAM exec role, log group, SQS event source mapping with `ReportBatchItemFailures`); see [[events-pipeline-design]] |
| `infra/modules/db-app-user` | engine-parameterized least-privilege DB app-user (Terraform, phase 2) — see [[two-phase-terraform-apply]] |
| `infra/modules/tf-backend` | create-once bootstrap: the remote-state S3 bucket + versioning, the state-lock DynamoDB table, and the `execution_log` DynamoDB table every awscli-fallback `local-exec` script records its run to — see [[terraform-remote-state-backend]] |
| `infra/modules/dynamodb` | the `websocket_connections` table backing the realtime fan-out: PK `connection_id`, GSI `by-cognito-sub`, TTL on `ttl` as a safety net (not the cleanup mechanism); see [[events-pipeline-design#Realtime WebSocket fan-out (second output of TRACKING_STATUS_CHANGED)]] |
| `infra/modules/api-gateway-ws` | a **separate** WebSocket API (`aws_apigatewayv2_api`, `protocol_type = "WEBSOCKET"`), its stage, a REQUEST authorizer on `$connect` only, and the four `realtime-events` Lambda functions declared directly inside this module — see [Why `api-gateway-ws` is a new module, and why `lambda/` was not reused](#why-api-gateway-ws-is-a-new-module-and-why-lambda-was-not-reused) below |
| `infra/modules/redis` | ElastiCache `aws_elasticache_replication_group` (never `aws_elasticache_cluster`) backing Users' password-reset codes; awscli fallback for Floci (provider panics on `NodeGroups[0]`), no subnet-group support on Floci at all, and two Floci-only ports that must not be conflated — see [[redis-elasticache-replication-group-floci]] |

There is no `ecs-service`, `secrets`, or `ecr` module — those are not part of the current
inventory.

### Why `api-gateway-ws` is a new module, and why `lambda/` was not reused

Two separate decisions, both from [[2026-08-05-realtime-tracking-events-websocket-design]]:

**A new API Gateway module, not a flag on the existing `api-gateway` module.** AWS does not allow
a single `aws_apigatewayv2_api` to mix protocols — a WebSocket API (`protocol_type = "WEBSOCKET"`)
is a genuinely separate resource from the existing HTTP API, sharing no resources, variables, or
locals with it. The existing `api-gateway` module is built entirely around HTTP-API shapes that
don't apply here: a `local.routes` map with a per-route `auth` boolean, per-route `HTTP_PROXY`
integrations (the Floci workaround in
[[local-gateway-per-route-integrations]]), and a native Cognito JWT authorizer. A WebSocket API's
integrations are `AWS_PROXY` to Lambda, and its only usable authorizer type is REQUEST — neither
shape exists in `api-gateway` today.

**`infra/modules/lambda/` was not reused for the four `realtime-events` functions.** That module
is coupled to SQS by design: it exposes `queue_arn`/`batch_size` as inputs and creates an
`aws_lambda_event_source_mapping` (see its row above and [[events-pipeline-design]]). The
`realtime-events` functions are invoked by API Gateway, not by a queue — there is no event source
mapping to create for any of them. Rather than making the event source mapping optional inside
`lambda/` (a generic Lambda wrapper with conditional branches for a shape it was never designed
for), the four Lambda resources are declared **directly inside** `api-gateway-ws`, colocated with
the routes and REQUEST authorizer whose lifecycle they share exactly. This keeps `lambda/`
meaning "SQS-consumer Lambda," a single well-defined shape, rather than a generic wrapper.

> [!note] Why `docdb` and `rds-aurora` stay separate
> Both provision databases, but they are different AWS services with different providers and
> lifecycles: `rds-aurora` manages `aws_rds_cluster` (writer + reader instances, Secrets Manager
> credentials, PostgreSQL roles/grants) and is already engine-agnostic across Postgres and MySQL.
> `docdb` manages `aws_docdb_cluster`/`aws_docdb_cluster_instance` — a distinct resource family
> with its own subnet group and its own awscli fallback for Floci. Unifying them into one
> switch-module would produce no shared resources, only a branch on which AWS service to call.
> The module previously named `database` was renamed to `docdb` (2026-08-04) precisely because
> the old name suggested a generic/shared database module when it only ever created DocumentDB.

Two Cognito resources are wired against Floci via the **awscli-fallback pattern**
(`terraform_data` + `local-exec` + an idempotent script, outside Terraform's normal resource
lifecycle) because the native Terraform resource cannot apply against Floci at the pinned
provider version: the Cognito App Client and the Pre-Token-Generation V2 trigger. See
[[awscli-fallback-for-floci]] for the pattern and why each case needed it.

### Local composition and its follow-on decisions

`infra/environments/local` composes `label`, `networking`, `rds-aurora`, `cognito`, `compute`,
`api-gateway`, `messaging`, `docdb`, `lambda`, `dynamodb`, `api-gateway-ws`, and `redis` against
Floci. Several decisions layered on top of that initial composition:

- **`redis` follows the same awscli-fallback shape as `docdb`'s Floci path** — a third verified
  case of [[awscli-fallback-for-floci]] in this repo — because the pinned AWS provider panics
  creating the ElastiCache replication group against Floci's response shape; see
  [[redis-elasticache-replication-group-floci]] for the module decision and
  [[floci-elasticache-two-ports-and-provider-panic]] for the empirical findings behind it.

- **`rds-aurora` has a switchable engine** (`var.engine`, default `aurora-postgresql`) so local
  can instantiate real Floci Postgres/MySQL containers instead of Aurora, which Floci does not
  emulate — see [[rds-aurora-engine-switchable-floci]].
- **A second Terraform apply phase** (`environments/local/post/`) creates least-privilege
  database app-users natively, after the base infra is live, resolving the provider
  chicken-and-egg that previously pushed this into bash — see [[two-phase-terraform-apply]].
- **State moved to a remote S3 + DynamoDB backend** (a create-once bootstrap root +
  per-environment `backend.hcl`), ending local `.tfstate` drift against Floci — see
  [[terraform-remote-state-backend]].
- **The local API Gateway uses per-route integrations**, and the local nginx reverse proxy
  injects `x-user-id` via njs — both are Floci-only workarounds for gaps in the emulator; see
  [[local-gateway-per-route-integrations]] and [[nginx-njs-x-user-id-injection]].

### SNS fan-out and the notifications queue (2026-09-15)

> [!info] Shipped 2026-09-15 — In-App Notifications milestone
> Full design: [[2026-09-10-in-app-notifications-design]]. De-risked first by a throwaway Floci
> probe: [[floci-sns-fanout-support]] (all four assertions held — fan-out, raw delivery,
> `MessageAttributes` survival, and filter-policy enforcement — so the design shipped unchanged).

`infra/modules/messaging` gained an SNS topic and a second SQS queue, so the three producers
(Users, Orders, Tracking) can feed **two** independent consumers — the existing events-pipeline
Lambda and the new in-process Users consumer — from one publish call. SQS alone could not do
this: it is point-to-point, so a second consumer on the existing `<id>-events` queue would steal
roughly half of every message type from whichever consumer lost the race.

| Resource | Notes |
|---|---|
| `aws_sns_topic.events` (`<id>-events-topic`) | The single publish target for all three producers, replacing their direct `SendMessageCommand` calls. |
| `aws_sqs_queue.notifications` (`<id>-notifications`) | Consumed in-process by Users (see [[users-service-design#The sqs-consumer — started in server.ts, never in buildApp()]]). **Its DLQ target is the SHARED `dlq`** — a poison message is a poison message whichever consumer choked on it, and a second DLQ only doubles the places an operator has to triage. |
| `aws_sns_topic_subscription.events_queue` | Subscribes the existing `<id>-events` queue, `raw_message_delivery = true`, no filter — every event still reaches the pipeline unchanged. |
| `aws_sns_topic_subscription.notifications_queue` | Subscribes `<id>-notifications`, `raw_message_delivery = true`, plus `filter_policy_scope = "MessageAttributes"` and a `filter_policy` on `type` admitting exactly `USER_CREATED`, `ORDER_CREATED`, `TRACKING_STATUS_CHANGED`. |
| `aws_sqs_queue_policy.main_from_sns` / `notifications_from_sns` | One per queue, each naming the topic's ARN in an `AllowSnsDelivery` statement. |

> [!warning] Both queues need a policy, or SNS delivery is silently dropped
> A queue with no policy naming the topic simply never receives the message — the publish still
> reports success at the publisher, and nothing appears at the consumer. This is not a permission
> **error**, it is silent delivery loss, which is why both policies exist even though the
> notifications queue is brand new and might otherwise seem to need only the filter.

**Raw message delivery on both subscriptions is the load-bearing detail**, not an optional
tuning knob: without it, SNS wraps the body in its own JSON envelope, and the events-pipeline's
`EnvelopeSchema` would receive an SNS envelope instead of the domain envelope it expects —
breaking all three existing handlers silently. With raw delivery the body is byte-for-byte what
producers publish today, so the pipeline's own code needed zero changes (see
[[events-pipeline-design#Transport change (2026-09-15): producers now publish to SNS, not SQS directly]]).
`MessageAttributes` (`type`, `source`, `traceparent`) survive raw delivery on both subscriptions
too — the filter policy depends on the first, and distributed tracing continuity depends on the
second (see [[ADR-0019-distributed-tracing-opentelemetry]]).

**No new Lambda-owning module.** The consumer for the notifications queue lives **inside Users**,
an existing long-running process, not a new Lambda — so unlike `dynamodb`/`api-gateway-ws` (added
for the realtime WebSocket feature), this change needed no new compute module, only the two new
resources above plus the existing `messaging` module's outputs.

> [!warning] `sns` must be declared in the local provider's `endpoints` block
> `infra/environments/local/providers.tf` must declare `sns = "http://localhost:4566"` alongside
> every other Floci-routed service — an undeclared service sends the call to real AWS, which
> rejects the test credentials with `InvalidClientTokenId` rather than reaching Floci at all. This
> is the same class of trap the provider file's own CONTRACT comment already documents for
> `events`/EventBridge (the provider's SNS service key is simply `sns`, no alias to get wrong).

## Naming Convention

Every module instantiation passes a `context` object sourced from the root
`cloudposse/label/null` context:

```hcl
module "label" {
  source    = "cloudposse/label/null"
  version   = "0.25.0"

  namespace   = "3mrai"
  environment = var.environment   # dev | staging | prod
  stage       = var.stage         # e.g. blue | green
  name        = var.service_name  # users | orders | tracking | events-pipeline
}
```

Resource names are derived via `module.label.id` (e.g. `3mrai-prod-users`). Tags inherit
`module.label.tags` automatically.

## Cross-cutting rules

- All modules expose a `context` input (the label context) so parent compositions control
  naming without duplicating variables.
- Outputs from every module include `name`, `arn`, and `tags` for downstream consumption.
- Sensitive outputs (passwords, tokens) are marked `sensitive = true` and never logged.
- See [[ADR-0001-terraform-cloudposse-naming]] for the full naming rationale.

## Related

- [[2026-09-10-in-app-notifications-design]] — the design behind the SNS fan-out topic and the
  notifications queue documented above.
- [[floci-sns-fanout-support]] — the Floci probe that verified SNS fan-out, raw delivery, and the
  filter policy before this change shipped.
- [[users-service-design]] — the in-process consumer for the new `<id>-notifications` queue.
- [[ADR-0001-terraform-cloudposse-naming]]
- [[ADR-0017-floci-local]]
- [[local-dev-floci]]
- [[cognito-pre-token-lambda]]
- [[awscli-fallback-for-floci]]
- [[networking]]
- [[aws-resources]]
- [[rds-aurora-engine-switchable-floci]]
- [[two-phase-terraform-apply]]
- [[terraform-remote-state-backend]]
- [[local-gateway-per-route-integrations]]
- [[nginx-njs-x-user-id-injection]]
- [[events-pipeline-design]]
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design for `dynamodb` and
  `api-gateway-ws`, including why the latter is a new module and why `lambda/` was not reused.
- [[2026-08-05-realtime-tracking-events-websocket]] — the implementation plan that shipped both
  modules.
- [[redis-elasticache-replication-group-floci]] — the `redis` module: why a replication group,
  the awscli fallback for Floci, and the two-ports trap.
- [[self-owned-password-reset-codes-in-redis]] — the Users-side consumer of this module's output.
