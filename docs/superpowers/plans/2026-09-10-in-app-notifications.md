---
title: In-App Notifications Implementation Plan
type: plan
area: shared
status: draft
created: 2026-09-10
updated: 2026-09-10
tags:
  - type/plan
  - area/shared
  - status/draft
propagates-to:
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[terraform-modules]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[2026-08-17-web-app-foundation-design]]"
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[terraform-modules]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[soft-delete]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[audit-fields]]"
  - "[[nano-id]]"
  - "[[env-files]]"
  - "[[ADR-0017-floci-local]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[pencil-design-extraction]]"
  - "[[doc-propagation]]"
---

# In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users an in-app notification inbox — bell panel, full-page list, and live toasts — produced from events the system already emits, stored in the Users service's Postgres, read through three new Users endpoints, and pushed live over the existing WebSocket channel.

**Architecture:** An SNS topic replaces the three producers' direct SQS `SendMessage`, fanning one published envelope out to two queues with **raw message delivery** so the events-pipeline Lambda's body is byte-for-byte unchanged and the pipeline changes not one line. A second queue (`<id>-notifications`), filtered by the `type` message attribute, feeds an `sqs-consumer` running inside the Users process; the consumer maps each event to a rendered `title`/`body` plus a `metadata` JSON, inserts a `Notification` row, and pushes `NOTIFICATION_CREATED` to the owner's open sockets through the `@connections` management API. The web app binds its already-built (fixture-backed) notification components to a real NgRx store and a new WebSocket client.

**Tech Stack:** Terraform (`aws_sns_topic`, `aws_sqs_queue`, `aws_sns_topic_subscription`) · Users: Fastify 5, Prisma 7.8 (`prisma-client` generator), Awilix 13, `sqs-consumer`, `@aws-sdk/client-sns`, `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-dynamodb` + `lib-dynamodb`, Zod (`zod/v4`), Vitest · Orders: .NET 10, `AWSSDK.SimpleNotificationService` · Tracking: Go 1.26.7, `aws-sdk-go-v2/service/sns` · Web: Angular 22, NgRx `@ngrx/signals` 22, Tailwind 4.3.3 · E2E: Playwright, Gatling JS.

**Spec:** `docs/superpowers/specs/2026-09-10-in-app-notifications-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **pnpm ONLY** — never `npm` or `yarn`, including for brand-new sub-projects. Use `pnpm add`, `pnpm --filter <pkg> <script>`, `pnpm dlx` (never `npx`). A bare `npm install` corrupts the pnpm tree. See [[package-manager]].
- **Run `nvm use` before ANY Node command.** The repo pins Node **24.18.0** via `.nvmrc`.
- **NO AGENT RUNS GIT WRITES.** Every task's final "Commit" step is an instruction for the **human / main session**, which runs it only after the A/B/C/D/E confirmation menu (rendered via `AskUserQuestion`). A task implementer leaves its work **edited and uncommitted** in the working tree and reports what changed. Read-only git (`status`, `diff`, `log`, `show`) is fine. See [[git-workflow]].
- **Conventional Commits v1.0.0**: `<type>(<scope>): <description>`. Scopes used here: `users`, `orders`, `tracking`, `infra`, `web`, `e2e`, `vault`.
- **Code comments — closed set of five tags**: `CONTRACT:`, `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`. Untagged comments ≤6 lines; **a block over 12 lines is an error**. **PRESENT TENSE describing the final state only** — never debugging history (`became`, `was broken`, `we switched`, `after the fix` are all violations). Vault refs as `See [[note-id]]` (bare basename, no `docs/` prefix, no `.md`, no `#anchor`). Gate: `make lint-comments`.
- **Env files are GENERATED, never hand-edited.** New env vars go into `infra/environments/local/scripts/generate_env_files.py` **and** the Zod schema at `services/users/src/shared/config/env.ts`. See [[env-files]].
- **Python for new infra scripts**; JavaScript only where the task already lives in the Node ecosystem.
- **Money/ids/casing are wire contracts.** Each producer's existing envelope and `MessageAttributes` must be preserved **byte-for-byte** — the pipeline's `EnvelopeSchema` rejects an extra key, and `request_id` must be **OMITTED, never null**.
- **Never log** passwords, tokens, or full request bodies; **never a plaintext email** — use `email_hash`. Flow logs use `app_event` (`<flow>_started|_succeeded|_failed`) plus `reason` on failures. Unknown fields are **omitted, never null**. There is **no SUCCESS severity**. See [[logging-context]].
- **Three test layers per endpoint** — unit/integration, internal E2E (direct service URL), and gateway E2E with a real Cognito JWT. An endpoint without gateway E2E is an incomplete change. See [[testing]].
- **Assertions print WHAT arrived, not just counts.** A "got 3 of 4" assertion cannot distinguish a broken system from a wrong expectation.
- **No Tailwind arbitrary value for a design colour.** Verify with `grep -rnE '(bg|text|border)-\[#' apps/web/src/` → expect **no matches**. Tokens live in `apps/web/src/styles.css` as `@theme` entries; the `--color-*` prefix is mandatory or the utility silently does not exist.
- **The `.pen` is encrypted** — read it ONLY over the Pencil MCP, never with Read/Grep. `assets/web-app/web-app.pen`.
- **Cap of 50** on the notifications list and on the PATCH `ids` array. **No pagination** (explicitly declined). `window_days` is **90** and bounds `window_total` **only** — the list query has **no date bound**.
- **Toast auto-dismiss is 7 seconds**, pausable on hover and focus-within, and the progress bar's animation duration is driven by **the same constant** as the dismiss timer.
- **No idempotency key on `Notification`** (approved decision 4). Do **not** add a `@unique` on an event id. Duplicates on SQS redelivery are an accepted, informed outcome.
- **No retention/cleanup job** (approved decision 9). Rows are kept indefinitely.

---

## Verified ground truth (read before starting any task)

These were verified against the code at plan time. They correct or sharpen the spec; each is called out again in the task that depends on it.

1. **`PLACED` is NEVER published as a `TRACKING_STATUS_CHANGED` event, so `ORDER_CREATED` triggers the `PLACED` copy variant.** `services/tracking-go/internal/app/create_tracking.go:98-101` carries the explicit contract: *"It publishes NOTHING. Creation emits no SQS event — only status transitions do, which is why a TestMode run leaves five history rows and sends four events."* Publishing happens only from `internal/app/update_status.go:194`. The existing gateway spec `e2e/tests/gateway/realtime-tracking.spec.ts` asserts **four** messages for **five** statuses for exactly this reason. The spec's decision 2 flagged this as a plan-time verification; the verification ran and **failed**, and the spec was corrected on 2026-09-10: **`ORDER_CREATED` is the trigger for the `PLACED` variant.** It is genuinely emitted, already registered in the pipeline's dispatch (`orderCreatedHandler` in `functions/events-pipeline/src/handlers/index.ts`), and its handler already sends the "Order confirmed" email (`functions/events-pipeline/src/handlers/order-created.ts:98`). This is **no longer an open concern** — see "Concerns raised during planning" §1 for the resolved record and the rejected alternative. **Tracking is not modified by this plan**, and the realtime-tracking E2E CONTRACT above stays true and untouched.

   The consequence for the type model, carried through Tasks 3.2, 3.5, 3.6, 4.2, 4.5 and 4.6: a `TRACKING_STATUS_CHANGED` **event** can only be one of the four transition statuses, while a stored `metadata.status` is still one of five (`PLACED` included, written by the `ORDER_CREATED` path). Those are two different types and the plan spells them as two: `TrackingEventStatus` (four) and `TrackingStatus` (five).

1b. **`ORDER_CREATED`'s payload carries everything the consumer needs — no extra lookup.** `OrderCreatedPayloadSchema` at `functions/events-pipeline/src/handlers/order-created.ts:24` declares `order_id` (required), `order_number` (`OrderNumberSchema.optional()` — the same `{raw, formatted}` pair tracking sends, so `.formatted` is the display form and it may be **absent**), `user_id` (required), `created_at` (required), plus `email`, `full_name`, the four money integers, `shipping_address` and the items array. So `occurred_at` comes from `created_at` and the `<ORDER_NUMBER>` body prefix from `order_number.formatted`, tolerating its absence exactly as the tracking path does. The spec's "confirm the field name at implementation time" hedge is **discharged**: these are the confirmed names.
2. **Email/notification title parity already holds.** `functions/events-pipeline/emails/tracking-status-changed.tsx:60-79` defines `COPY` with headings `Order placed` / `Your order is being prepared` / `Your order has shipped` / `Out for delivery` / `Delivered` — identical to the spec's five tracking titles. Task 3.3 pins this with a regression test rather than re-deriving it.
3. **No new nginx `location` block is needed.** `/v1/notifications` falls under `location /`, which already proxies to Users on `:3000` — the same reasoning the route map records for `/v1/users/me` (`infra/modules/api-gateway/main.tf:51-56`: *"No nginx `location` needed: /v1/users/me falls under `location /`, which already proxies to Users."*). A `location` block is required only for a top-level path owned by a **different** service (`/v1/products`, `/v1/cart`, `/v1/trackings`). The API Gateway route map entries **are** required.
4. **Users has no IAM task role.** `infra/modules/compute/main.tf` declares only `aws_iam_role.ecs_execution` (line 19), used as `execution_role_arn` (line 56) — there is no task role. Users runs as a docker-compose service authenticating to Floci with static `AWS_ACCESS_KEY_ID=test` / `AWS_SECRET_ACCESS_KEY=test` written by the env generator (`generate_env_files.py:311-313`). The spec's "IAM permission for `@connections` and the DynamoDB connections table" is therefore a **no-op locally**; the Lambda-only machinery lives at `infra/modules/lambda/main.tf:104-120` and `infra/modules/lambda/variables.tf:72`. Task 1.4 records this rather than inventing a role.
5. **Every Terraform output the env generator needs already exists**: `ws_url`, `ws_connections_table`, `ws_connections_gsi`, `ws_management_endpoint` (`infra/environments/local/outputs.tf:124-146`), read at `generate_env_files.py:228-234`. Only the two new SNS/queue outputs are new.
6. **The SQS consumer must start in `server.ts`, NOT in `buildApp()`.** `services/users/src/server.ts` carries a CONTRACT for the metrics poller: *"Start the metrics poller here, NOT in buildApp() — the test suite calls buildApp too, and a live timer in every run would hit the database outside any test's control."* The consumer has exactly this hazard (a live SQS long-poll in every Vitest run). The spec says "registered as a Fastify plugin"; starting it in `server.ts` resolved from `app.diContainer` and stopped on `SIGTERM` is a **faithful refinement of that intent**, matching the established pattern. See Task 3.5.
7. **The Prisma cross-cutting extension auto-stamps `id` and `createdBy`** from `MODEL_ID_PREFIXES` and the AsyncLocalStorage actor (`services/users/src/shared/db/prisma-extensions.ts:217-234`). The consumer runs **outside any request**, so `getActor()` returns `undefined` and `createdBy` would be `null` — but the spec's model declares `createdBy String` (non-nullable). The consumer therefore passes `createdBy` explicitly. Task 3.1 adds `Notification: "ntf_"` to `MODEL_ID_PREFIXES` and `notification: isDeletedField` to `RESULT_EXTENSIONS` (a test asserts the schema and that map agree).
8. **Web components already exist, fixture-backed.** `apps/web/src/app/shared/ui/notification-item.{ts,html}`, `toast-notification.{ts,html}`, `apps/web/src/app/features/notifications/notifications-panel.{ts,html}`, and `AppNotification` at `apps/web/src/app/core/api/types.ts:265-272` (`{id, title, body, status, createdAt, read}`). Phase 4 **rewires** them to a real store and widens the type; it does not create them. The fixture `apps/web/src/app/fixtures/notifications.fixture.ts` is deleted.
9. **Design-token names are REMAPPED from their `.pen` originals.** Per `apps/web/DESIGN.md:42`: `text-secondary` → `--color-ink-secondary`; `success-text` → `--color-success-ink`; `warn-text` → `--color-warn-ink`; `border-color` → `--color-line`; `bg-subtle` → `--color-surface-subtle`. The spec's copy table uses the **`.pen`** names; Task 4.2's copy map uses the **`styles.css`** names.
10. **Neither SNS SDK is installed.** `services/users/package.json` has `@aws-sdk/client-sqs` but no `client-sns`, no `client-apigatewaymanagementapi`, no `client-dynamodb`, and no `sqs-consumer`. `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj:14-15` pins `AWSSDK.CloudWatch 4.0.101` and `AWSSDK.SQS 4.0.100.7` with a documented **v3/v4 mixing hazard** — the SNS package must be a v4 line. `services/tracking-go/go.mod:8-11` has `service/sqs v1.48.0` but no `service/sns`.

---

## File Structure

### Phase 0 — the Floci SNS POC (throwaway, outside Terraform)

| File | Responsibility |
|---|---|
| `infra/poc/sns-fanout/main.tf` | **Create.** Throwaway Terraform: one SNS topic, two SQS queues, two subscriptions with `raw_message_delivery = true`, one carrying a `filter_policy` on `type`. Deleted at the end of the phase. |
| `infra/poc/sns-fanout/verify_fanout.py` | **Create.** Python probe: `Publish` two envelopes (one `USER_CREATED`, one `ORDER_CREATED`), then `ReceiveMessage` from **both** queues and assert byte-for-byte body equality, `MessageAttributes` presence, and that the filtered queue received only the allowed type. Deleted at the end of the phase. |
| `docs/lessons/2026-09-10-floci-sns-fanout-support.md` | **Create (via `obsidian-vault`).** The durable output of the phase: what SNS on Floci does and does not support, which of the two failure modes (if any) occurred, and the decision that follows. |

### Phase 1 — infrastructure

| File | Responsibility |
|---|---|
| `infra/modules/messaging/main.tf` | **Modify.** Adds `aws_sns_topic.events`, `aws_sqs_queue.notifications`, two `aws_sns_topic_subscription`s (raw delivery; the notifications one filtered by `type`), and the two `aws_sqs_queue_policy`s letting SNS deliver. |
| `infra/modules/messaging/variables.tf` | **Modify.** Adds `notification_event_types` (the filter-policy allowlist) and `notifications_visibility_timeout_seconds`. |
| `infra/modules/messaging/outputs.tf` | **Modify.** Adds `topic_arn`, `notifications_queue_url`, `notifications_queue_arn`. |
| `infra/environments/local/outputs.tf` | **Modify.** Surfaces `events_topic_arn` and `notifications_queue_url` for the env generator. |
| `infra/environments/local/main.tf` | **Modify.** Passes `EVENTS_TOPIC_ARN` to the OTP-challenge Lambda (which publishes `AUTH_OTP_REQUESTED`) alongside the queue url it already receives. |
| `infra/environments/local/scripts/generate_env_files.py` | **Modify.** Reads the two new outputs and writes `EVENTS_TOPIC_ARN` + `WS_MANAGEMENT_ENDPOINT` + `WS_CONNECTIONS_TABLE` + `WS_CONNECTIONS_GSI` + `NOTIFICATIONS_QUEUE_URL` into `.env.local.users`, and `EVENTS_TOPIC_ARN` into `.env.local.orders`, `.env.local.tracking`, `.env.local.debug`. |
| `infra/modules/api-gateway/main.tf` | **Modify.** Adds the three notification routes to `local.routes`, all `auth = true`. |

### Phase 2 — producers

| File | Responsibility |
|---|---|
| `services/users/src/shared/messaging/event-publisher.ts` | **Modify.** `SqsEventPublisher` → `SnsEventPublisher`: `SendMessageCommand`/`SQSClient` → `PublishCommand`/`SNSClient`, `queueUrl` → `topicArn`. The envelope, both payloads, and the `MessageAttributes` shape are unchanged. |
| `services/users/src/shared/di/awilix-container.ts` | **Modify.** `sqsClient` → `snsClient`, `EVENTS_QUEUE_URL` → `EVENTS_TOPIC_ARN`. |
| `services/users/src/shared/config/env.ts` | **Modify.** Adds `EVENTS_TOPIC_ARN`, `NOTIFICATIONS_QUEUE_URL`, `WS_MANAGEMENT_ENDPOINT`, `WS_CONNECTIONS_TABLE`, `WS_CONNECTIONS_GSI`. `EVENTS_QUEUE_URL` is removed once no code reads it. |
| `services/users/src/shared/observability/publish-tracing.ts` | **Modify.** Span name `sqs.publish <type>` → `sns.publish <type>`; `messaging.system` `aws_sqs` → `aws_sns`; `messaging.destination.kind` `queue` → `topic`. |
| `services/orders/src/Orders.Infrastructure/Messaging/SnsEventPublisher.cs` | **Create.** Renamed from `SqsEventPublisher.cs`, `IAmazonSQS`/`SendMessageRequest` → `IAmazonSimpleNotificationService`/`PublishRequest`. Every envelope record and `BuildMessageAttributes` is carried over unchanged. |
| `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs` | **Delete** (replaced by the file above). |
| `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` | **Modify.** `AWSSDK.SQS` → `AWSSDK.SimpleNotificationService`, on the **v4** line. |
| `services/orders/src/Orders.Api/Program.cs` | **Modify.** Registers `IAmazonSimpleNotificationService`; reads `EVENTS_TOPIC_ARN`; `AddSource(SnsEventPublisher.ActivitySourceName)`. |
| `services/tracking-go/internal/adapter/sqs/publisher.go` | **Modify.** `SendMessageAPI` → `PublishAPI`, `awssqs.SendMessageInput` → `awssns.PublishInput`, `queueURL` → `topicARN`, and `buildMessageAttributes` returns `snstypes.MessageAttributeValue`. Package path and envelope are untouched. |
| `services/tracking-go/internal/platform/config/config.go` | **Modify.** `EventsQueueURL` → `EventsTopicARN`, reading `EVENTS_TOPIC_ARN`. |
| `services/tracking-go/cmd/server/main.go` | **Modify.** Constructs the SNS client and passes the topic ARN. |
| `services/tracking-go/go.mod` / `go.sum` | **Modify.** Adds `github.com/aws/aws-sdk-go-v2/service/sns`. |

### Phase 3 — Users backend

| File | Responsibility |
|---|---|
| `services/users/prisma/schema.prisma` | **Modify.** Adds the `Notification` model. |
| `services/users/prisma/migrations/20260910000000_add_notifications/migration.sql` | **Create.** The `notifications` table and its two indexes. |
| `services/users/src/shared/id/nano-id.ts` | **Modify.** Adds `Notification: "ntf_"` to `PREFIXES`, `newNotificationId`, and the `MODEL_ID_PREFIXES` entry. |
| `services/users/src/shared/db/prisma-extensions.ts` | **Modify.** Adds `notification: isDeletedField` to `RESULT_EXTENSIONS`. |
| `services/users/src/shared/audit/audit-actor.ts` | **Modify.** Adds `NotificationCreated` and `NotificationsMarkedRead`. |
| `services/users/src/features/notifications/domain/notification-copy.ts` | **Create.** The copy map: the eleven variants' `title`/`body`, the two composed bodies, the toast eyebrow/CTA, and the icon/tint/icon-colour triples. The single source of rendered copy. |
| `services/users/src/features/notifications/domain/notification.ts` | **Create.** The domain type and the row→domain mapper. |
| `services/users/src/features/notifications/messaging/notification-consumer.ts` | **Create.** The `sqs-consumer` wiring: builds the `Consumer`, continues the trace from `traceparent`, discards non-notification types, and never throws on a permanent error. |
| `services/users/src/features/notifications/commands/create-notification.ts` | **Create.** Maps one envelope to a row, inserts it, then pushes over the socket. Owns the `notification_created` flow log. |
| `services/users/src/features/notifications/commands/mark-notifications-read.ts` | **Create.** The `PATCH` command: `WHERE id IN (:ids) AND user_id = :id AND read_at IS NULL`, returning `{updated, unread_count}`. |
| `services/users/src/features/notifications/queries/list-notifications.ts` | **Create.** The `GET` query: newest 50 by `createdAt desc`, plus `unread_count` and the 90-day `window_total`. |
| `services/users/src/shared/realtime/connections-reader.ts` | **Create.** Users' own copy of the pipeline's DynamoDB GSI reader (`queryByCognitoSub`, `deleteConnection`). |
| `services/users/src/shared/realtime/websocket-publisher.ts` | **Create.** Users' own `publishToUser`, mirroring the pipeline's: PRODUCER span, reactive delete on 410, **never throws**. |
| `services/users/src/features/notifications/http/schemas.ts` | **Create.** The Zod request/response schemas for the three routes. |
| `services/users/src/features/users/http/routes.ts` | **Modify.** Registers the three routes inside the existing `app.after()` block. |
| `services/users/src/server.ts` | **Modify.** Starts the consumer (resolved from `app.diContainer`) and stops it on `SIGTERM`, beside the metrics poller. |
| `services/users/src/shared/di/awilix-container.ts` | **Modify.** Registers the consumer, the three use cases, and the realtime publisher. |
| `services/users/package.json` | **Modify.** Adds `sqs-consumer`, `@aws-sdk/client-sns`, `@aws-sdk/client-sqs` (kept, for the consumer), `@aws-sdk/client-apigatewaymanagementapi`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`. |
| `services/users/vitest.config.ts` | **Modify.** Adds the five new env vars so the suite still imports. |
| `services/users/tests/features/notifications/notification-copy.test.ts` | **Create.** The eleven variants, the two composed bodies, absent-`order_number` tolerance, and the email-title parity guard. |
| `services/users/tests/features/notifications/create-notification.test.ts` | **Create.** Envelope→row mapping, the non-notification discard, and push-failure isolation. |
| `services/users/tests/features/notifications/mark-notifications-read.test.ts` | **Create.** Ownership scoping, idempotency, the empty list, and the 50 cap. |
| `services/users/tests/features/notifications/list-notifications.test.ts` | **Create.** The three filters, the 50 cap, and `window_total` exceeding `items.length`. |
| `services/users/tests/features/notifications/routes.test.ts` | **Create.** The three routes' status codes, the 401 without `x-user-id`, and the single-id-404. |
| `services/users/openapi.yaml` | **Modify (generated).** Regenerated by `pnpm --filter users generate:openapi`. |

### Phase 4 — web

| File | Responsibility |
|---|---|
| `assets/web-app/web-app.pen` | **Modify (via Pencil MCP `SetVariables`).** Adds `brand-navy-light` and a neutral token for `PLACED`'s `#E5E7EB`. |
| `apps/web/src/styles.css` | **Modify.** Propagates the two new tokens as `@theme` `--color-*` entries. |
| `apps/web/DESIGN.md` | **Modify.** Documents the two new tokens and their `.pen`→`styles.css` remapping. |
| `apps/web/src/app/core/api/types.ts` | **Modify.** Widens `AppNotification` to the wire shape (`type`, `metadata`, `readAt`) and adds `NotificationsPage`, `NotificationMetadata`, `NotificationType`. |
| `apps/web/src/app/core/api/notifications-api.ts` | **Create.** The three gateway calls. |
| `apps/web/src/app/core/notifications/notifications-store.ts` | **Create.** The NgRx signal store: list, `unreadCount`, `windowTotal`, the arrived-unread id set, and `markRead`. |
| `apps/web/src/app/core/notifications/notifications-socket.ts` | **Create.** The WebSocket client: connect with the id token, reconnect with backoff, and dispatch `NOTIFICATION_CREATED` into the store. |
| `apps/web/src/app/core/notifications/toast-queue.ts` | **Create.** The bounded toast queue and the 7-second pausable timer, exporting `TOAST_DISMISS_MS`. |
| `apps/web/src/app/shared/ui/notification-item.ts` / `.html` | **Modify.** Reads `readAt`/`type`/`metadata`; the icon/tint pair comes from a token map. |
| `apps/web/src/app/shared/ui/toast-notification.ts` / `.html` | **Modify.** Adds the eyebrow, the CTA, and the progress bar driven by `TOAST_DISMISS_MS`. |
| `apps/web/src/app/features/notifications/notifications-panel.ts` / `.html` | **Modify.** Store-backed; "Mark all as read" and the footer link now work. |
| `apps/web/src/app/features/notifications/notifications-all.ts` / `.html` | **Create.** The All screen: three filter pills, TODAY/YESTERDAY/EARLIER grouping, and mark-on-enter. |
| `apps/web/src/app/app.routes.ts` | **Modify.** Adds the `notifications` route under the authed app layout. |
| `apps/web/src/app/fixtures/notifications.fixture.ts` | **Delete.** Replaced by the real store. |
| `apps/web/src/app/core/notifications/notifications-store.spec.ts` | **Create.** Arrival highlight, mark-on-enter idempotency, and unread-count arithmetic. |
| `apps/web/src/app/core/notifications/toast-queue.spec.ts` | **Create.** The 7s dismiss, the hover/focus pause, and the queue bound. |

### E2E

| File | Responsibility |
|---|---|
| `e2e/tests/notifications.spec.ts` | **Create.** Internal E2E against Users directly on `:3000`. |
| `e2e/tests/gateway/notifications.spec.ts` | **Create.** Gateway E2E with a real Cognito JWT, including the `NOTIFICATION_CREATED` socket delivery and cross-user isolation. |
| `e2e/load-tests/simulations/notifications.gatling.ts` | **Create.** The sustained-read scenario for the two GETs and the PATCH. |

---

## Phase 0 — BLOCKING: the Floci SNS POC

**This phase is a HARD GATE. Nothing in Phases 1-4 starts until it resolves.** Everything here is
throwaway and is deleted at the end of the phase; the only durable output is the lesson note.

The spec's "Blocking prerequisite" section requires the POC to **prove, not assume**: a topic
created via Terraform, two queues subscribed, `Publish`, and **a read from BOTH queues** confirming
each got the same body with `MessageAttributes` present, plus that the filter policy actually
filters.

**Distinguish the two failure modes explicitly — knowing which one broke is the point:**

| What broke | Consequence for the design |
|---|---|
| **Fan-out fails outright** | Fall back to the already-chosen alternative: **the pipeline forwards to a Users queue with `SendMessage`** (SQS only, already verified). Phase 2 is then cancelled and Phase 3's consumer reads a queue the pipeline writes. |
| **Filter policy fails, fan-out works** | **The design stands.** The Users consumer discards by `type` in code — which it does anyway as defence in depth (approved decision 5). Only the `filter_policy` argument is dropped from Phase 1. |

### Task 0.1: Stand up the throwaway SNS fan-out in Terraform

**Files:**
- Create: `infra/poc/sns-fanout/main.tf`
- Create: `infra/poc/sns-fanout/.gitignore`

**Interfaces:**
- Consumes: nothing (a standalone Terraform root, deliberately outside `infra/environments/`).
- Produces: a running Floci stack containing SNS topic `3mrai-poc-events`, SQS queues
  `3mrai-poc-all` and `3mrai-poc-filtered`, and two subscriptions. Terraform outputs
  `topic_arn` (string), `all_queue_url` (string), `filtered_queue_url` (string) — consumed by
  Task 0.2's probe.

- [ ] **Step 1: Confirm the stack is up and no SNS exists yet**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
docker ps --filter name=floci --format '{{.Names}}\t{{.Status}}'
aws --endpoint-url http://localhost:4566 sns list-topics
```
Expected: the Floci container is `Up (healthy)`, and `list-topics` returns either
`{"Topics": []}` or an error. **An error naming an unknown service (`sns`) is itself the first
finding** — record it and go straight to Task 0.4, because fan-out is then broken outright.
If Floci is not up, run `make bootstrap` first.

- [ ] **Step 2: Write the throwaway Terraform root**

Create `infra/poc/sns-fanout/.gitignore`:
```gitignore
# Throwaway POC root — nothing here is committed, including its state.
*
```

Create `infra/poc/sns-fanout/main.tf`:
```hcl
# THROWAWAY: proves SNS fan-out on Floci before the design commits to it.
# Deleted at the end of Phase 0 — see docs/superpowers/plans/2026-09-10-in-app-notifications.md.
# Deliberately outside infra/environments/ so it shares no state with the real stack.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.31" }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    sns = "http://localhost:4566"
    sqs = "http://localhost:4566"
  }
}

resource "aws_sns_topic" "events" {
  name = "3mrai-poc-events"
}

# Stands in for the real <id>-events queue the pipeline consumes: NO filter,
# so it must receive every published message.
resource "aws_sqs_queue" "all" {
  name = "3mrai-poc-all"
}

# Stands in for the real <id>-notifications queue: filtered to the two types
# that produce a notification.
resource "aws_sqs_queue" "filtered" {
  name = "3mrai-poc-filtered"
}

# CONTRACT: raw_message_delivery = true on BOTH. Without it SNS wraps the body in
# its own JSON envelope and the pipeline's EnvelopeSchema receives an SNS envelope
# instead of the domain envelope, silently breaking all three existing handlers.
resource "aws_sns_topic_subscription" "all" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.all.arn
  raw_message_delivery = true
}

resource "aws_sns_topic_subscription" "filtered" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.filtered.arn
  raw_message_delivery = true

  # Filters on the `type` MESSAGE ATTRIBUTE, not the body — the body is opaque to
  # SNS under raw delivery.
  filter_policy_scope = "MessageAttributes"
  filter_policy = jsonencode({
    type = ["USER_CREATED", "ORDER_CREATED", "TRACKING_STATUS_CHANGED"]
  })
}

# Lets SNS deliver into each queue. Omitted, delivery is silently dropped.
resource "aws_sqs_queue_policy" "all" {
  queue_url = aws_sqs_queue.all.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.all.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}

resource "aws_sqs_queue_policy" "filtered" {
  queue_url = aws_sqs_queue.filtered.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.filtered.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}

output "topic_arn" { value = aws_sns_topic.events.arn }
output "all_queue_url" { value = aws_sqs_queue.all.id }
output "filtered_queue_url" { value = aws_sqs_queue.filtered.id }
```

- [ ] **Step 3: Apply it and see whether Floci accepts the topology**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/poc/sns-fanout
terraform init && terraform apply -auto-approve
```
Expected on success: `Apply complete! Resources: 7 added` and three outputs.
Expected failure modes to record verbatim rather than work around:
- `UnknownOperationException` / `InvalidAction` on `CreateTopic` → SNS is absent from this Floci
  build. **Fan-out broken outright.**
- An error on `aws_sns_topic_subscription` mentioning `raw_message_delivery` or
  `filter_policy` → the subscription attribute is unsupported. Note **which** attribute, because
  raw delivery failing is the fatal one and the filter policy failing is not.

- [ ] **Step 4: Confirm the subscriptions carry the attributes Terraform asked for**

Floci accepting an argument is not the same as honouring it, so read the attributes back.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/poc/sns-fanout
TOPIC_ARN="$(terraform output -raw topic_arn)"
aws --endpoint-url http://localhost:4566 sns list-subscriptions-by-topic \
  --topic-arn "$TOPIC_ARN" --query 'Subscriptions[].SubscriptionArn' --output text \
  | tr '\t' '\n' | while read -r sub; do
      echo "── $sub"
      aws --endpoint-url http://localhost:4566 sns get-subscription-attributes \
        --subscription-arn "$sub" \
        --query 'Attributes.{Raw:RawMessageDelivery,Filter:FilterPolicy,Scope:FilterPolicyScope}'
    done
```
Expected: both subscriptions report `"Raw": "true"`; exactly one reports a `Filter` naming
`USER_CREATED`, `ORDER_CREATED` and `TRACKING_STATUS_CHANGED`. **A subscription reporting `Raw: null` while
Terraform applied cleanly is the highest-value finding in this phase** — it is the silent version
of the fatal failure. Record it.

### Task 0.2: Prove fan-out, body fidelity and filtering with a Python probe

**Files:**
- Create: `infra/poc/sns-fanout/verify_fanout.py`

**Interfaces:**
- Consumes: Task 0.1's Terraform outputs `topic_arn`, `all_queue_url`, `filtered_queue_url`,
  read via `terraform output -raw`.
- Produces: a process exit code (0 = every assertion held) and a printed report. Nothing
  downstream imports it.

- [ ] **Step 1: Write the probe**

Python per [[scripting-language]] (it touches AWS and has non-trivial control flow), run from the
repo venv by absolute path.

Create `infra/poc/sns-fanout/verify_fanout.py`:
```python
"""THROWAWAY: proves SNS fan-out on Floci. Deleted at the end of Phase 0.

Publishes two envelopes and reads BOTH queues, because the failure this guards
against is a fan-out that delivers to one subscriber and silently drops the other
-- which a single-queue read reports as success.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import boto3

POC_DIR = Path(__file__).resolve().parent
ENDPOINT = "http://localhost:4566"

# One notification-producing type and one that must be filtered OUT. The filtered
# one is PASSWORD_RESET_REQUESTED because the real policy admits ORDER_CREATED —
# probing with a type the production policy accepts would prove nothing.
NOTIFYING_TYPE = "USER_CREATED"
FILTERED_TYPE = "PASSWORD_RESET_REQUESTED"


def tf_output(name: str) -> str:
    result = subprocess.run(
        ["terraform", f"-chdir={POC_DIR}", "output", "-raw", name],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def envelope(event_type: str) -> dict:
    """The real envelope shape, so body fidelity is tested on realistic bytes.

    Mirrors services/users/src/shared/messaging/event-publisher.ts: snake_case
    root, `order_id` present-and-null, `author` without a null cognito_sub.
    """
    return {
        "event_id": f"evt_poc{event_type.lower()}",
        "type": event_type,
        "source": "poc",
        "user_id": "usr_poc0000000000000000000",
        "order_id": None,
        "author": {"actor": "poc:verify", "user_id": "usr_poc0000000000000000000"},
        "payload": {"email": "poc@example.test", "fullName": "POC User"},
    }


def publish(sns, topic_arn: str, event_type: str) -> str:
    body = json.dumps(envelope(event_type))
    sns.publish(
        TopicArn=topic_arn,
        Message=body,
        MessageAttributes={
            "type": {"DataType": "String", "StringValue": event_type},
            "source": {"DataType": "String", "StringValue": "poc"},
            # The traceparent the real producers inject. Its survival is what
            # keeps distributed tracing intact across the topic.
            "traceparent": {
                "DataType": "String",
                "StringValue": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            },
        },
    )
    return body


def drain(sqs, queue_url: str, expected: int, timeout_s: int = 30) -> list[dict]:
    """Collect up to `expected` messages, waiting out SNS delivery latency."""
    collected: list[dict] = []
    deadline = time.time() + timeout_s
    while len(collected) < expected and time.time() < deadline:
        response = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=10,
            WaitTimeSeconds=2,
            MessageAttributeNames=["All"],
        )
        for message in response.get("Messages", []):
            collected.append(message)
            sqs.delete_message(
                QueueUrl=queue_url, ReceiptHandle=message["ReceiptHandle"]
            )
    return collected


def main() -> int:
    topic_arn = tf_output("topic_arn")
    all_url = tf_output("all_queue_url")
    filtered_url = tf_output("filtered_queue_url")

    sns = boto3.client("sns", endpoint_url=ENDPOINT, region_name="us-east-1")
    sqs = boto3.client("sqs", endpoint_url=ENDPOINT, region_name="us-east-1")

    # Start from empty so a leftover message cannot be mistaken for a delivery.
    for url in (all_url, filtered_url):
        sqs.purge_queue(QueueUrl=url)
    time.sleep(2)

    notifying_body = publish(sns, topic_arn, NOTIFYING_TYPE)
    filtered_body = publish(sns, topic_arn, FILTERED_TYPE)

    # The unfiltered queue must get BOTH; the filtered one only the first.
    all_messages = drain(sqs, all_url, expected=2)
    filtered_messages = drain(sqs, filtered_url, expected=1)

    failures: list[str] = []

    # Report WHAT arrived, never only how many -- a count alone cannot separate a
    # broken fan-out from a wrong expectation.
    def describe(messages: list[dict]) -> str:
        return json.dumps(
            [
                {
                    "type": m.get("MessageAttributes", {})
                    .get("type", {})
                    .get("StringValue"),
                    "body_prefix": m["Body"][:60],
                }
                for m in messages
            ],
            indent=2,
        )

    print(f"unfiltered queue received {len(all_messages)}:\n{describe(all_messages)}")
    print(f"filtered queue received {len(filtered_messages)}:\n{describe(filtered_messages)}")

    # ── 1. Fan-out reached both subscribers ──────────────────────────────────
    if len(all_messages) != 2:
        failures.append(
            f"FAN-OUT: unfiltered queue got {len(all_messages)} of 2 -> "
            "fan-out is broken; fall back to pipeline-forwards-to-Users-queue"
        )

    # ── 2. Body fidelity, byte for byte ─────────────────────────────────────
    bodies = {m["Body"] for m in all_messages}
    for label, published in (("notifying", notifying_body), ("filtered-type", filtered_body)):
        if published not in bodies:
            failures.append(
                f"RAW DELIVERY: the {label} body was altered in transit. "
                f"published={published!r}"
            )

    # ── 3. MessageAttributes survived ───────────────────────────────────────
    for message in all_messages:
        attributes = message.get("MessageAttributes") or {}
        for key in ("type", "source", "traceparent"):
            if key not in attributes:
                failures.append(
                    f"ATTRIBUTES: `{key}` is missing; got {sorted(attributes)}"
                )

    # ── 4. The filter policy actually filters ───────────────────────────────
    delivered_types = [
        m.get("MessageAttributes", {}).get("type", {}).get("StringValue")
        for m in filtered_messages
    ]
    if delivered_types != [NOTIFYING_TYPE]:
        failures.append(
            f"FILTER POLICY: filtered queue got {delivered_types}, want "
            f"['{NOTIFYING_TYPE}'] -> fan-out may still be fine; the consumer "
            "discards by `type` in code either way"
        )

    if failures:
        print("\nFAILED:")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("\nPASSED: fan-out, raw body fidelity, attributes and filtering all hold.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the probe and read the verdict**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make scripts-setup
.venv/bin/python infra/poc/sns-fanout/verify_fanout.py
```
Expected on success: `PASSED: fan-out, raw body fidelity, attributes and filtering all hold.`
On failure, the printed `FAILED:` list names which of the four assertions broke and, for the
two that matter, which fallback it implies. **Do not fix the probe to make it pass** — its
failure is the finding.

- [ ] **Step 3: Re-run it once to confirm the result is stable**

Run the same command a second time. A result that changes between runs is itself a finding (Floci
has a documented history of behaviour that expires — see [[floci-mysql-no-user-mgmt]]), and it
means the design cannot lean on the feature even if one run passed. Record both outcomes.

### Task 0.3: Verify SNS is reachable from inside the compose network

**Files:** none (a read-only probe).

**Interfaces:**
- Consumes: Task 0.1's `topic_arn` output.
- Produces: a recorded yes/no. Users publishes from **inside** `3mrai-network` at
  `http://floci:4566`, not from the host, and Floci has a documented history of a service
  answering on one route and not the other.

- [ ] **Step 1: Publish to the topic from inside the network**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/poc/sns-fanout
TOPIC_ARN="$(terraform output -raw topic_arn)"
docker run --rm --network 3mrai_3mrai-network \
  -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test -e AWS_DEFAULT_REGION=us-east-1 \
  amazon/aws-cli:latest \
  --endpoint-url http://floci:4566 sns publish \
  --topic-arn "$TOPIC_ARN" \
  --message '{"probe":"in-network"}' \
  --message-attributes '{"type":{"DataType":"String","StringValue":"USER_CREATED"}}'
```
Expected: a JSON body containing a `MessageId`. A connection error here while the host-side
publish in Task 0.2 succeeded means Users cannot reach the topic — a blocker distinct from SNS
being absent, and one the env generator's `AWS_ENDPOINT_URL=http://floci:4566` would hit on
first boot.

### Task 0.4: Record the findings as a vault lesson note

**Files:**
- Create: `docs/lessons/2026-09-10-floci-sns-fanout-support.md` — **routed through the
  `obsidian-vault` agent**, which is the sole writer of `docs/`.

**Interfaces:**
- Consumes: the recorded outcomes of Tasks 0.1-0.3.
- Produces: the phase's only durable artefact, and the gate's written verdict. Companion to the
  three existing Floci lesson notes.

- [ ] **Step 1: Hand the findings to `obsidian-vault`**

The note is a **companion to the existing Floci lessons**, so it must follow their shape. Give the
agent the outcomes and this required content:

- Frontmatter: `title`, `type: lesson`, `area: infra`, `status: active`, `created: 2026-09-10`,
  `updated: 2026-09-10`, tags `type/lesson`, `area/infra`, `status/active`, and a
  `severity/<x>` tag reflecting what was found.
- **What was probed and what answered** — `CreateTopic`, both subscriptions'
  `RawMessageDelivery` and `FilterPolicy` as read back by `get-subscription-attributes`, the
  two-queue drain, and the in-network publish.
- **The verdict, stated as one of the three outcomes**: all four assertions hold (the design
  stands unchanged); filter policy broken but fan-out fine (the design stands, the consumer
  discards by `type` in code, and Phase 1 drops the `filter_policy` argument); or fan-out broken
  (Phase 2 is cancelled and the pipeline forwards to a Users queue with `SendMessage`).
- **The exact error strings**, verbatim. A future reader re-probing needs to recognise the same
  failure, and a paraphrase is not recognisable.
- **A re-probe instruction.** Floci behaviour has expired twice in this repo
  (see [[floci-mysql-no-user-mgmt]]), so the note says to re-probe rather than to trust it
  indefinitely.
- A `## Related` section linking `[[2026-09-10-in-app-notifications-design]]`,
  `[[ADR-0017-floci-local]]`, `[[floci-sqs-lambda-docdb-support]]`, and
  `[[2026-08-05-realtime-tracking-events-websocket-design]]`.

- [ ] **Step 2: Validate the vault**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && node scripts/validate-vault.mjs
```
Expected: no broken wikilinks and no frontmatter errors. The "Propagation debt" count line is the
gate working, not failing.

- [ ] **Step 3: Tear down the POC**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/poc/sns-fanout
terraform destroy -auto-approve
cd .. && rm -rf sns-fanout
```
Expected: `Destroy complete!`, then the directory is gone. The POC is throwaway by design — leaving
it behind means a second SNS topic and two stray queues on every future `terraform apply` in a
sibling root, and a reader cannot tell the probe from the real infrastructure.

Verify nothing survived:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
git status --short infra/
aws --endpoint-url http://localhost:4566 sns list-topics
```
Expected: `git status` shows no `infra/poc/` entries, and `list-topics` no longer lists
`3mrai-poc-events`.

- [ ] **Step 4: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** The lesson note is the only file to commit; the POC is
deleted. The main session proposes, via the `AskUserQuestion` A/B/C/D/E menu:

```
docs(vault): record Floci SNS fan-out support from the blocking POC

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### 🚦 GATE 0 — STOP HERE

**Hand the user the verdict and wait.** This is a dependency gate, not a checkpoint to note in
passing: which of the three outcomes occurred decides whether Phase 2 exists at all. Do not begin
Phase 1 until the user has read the lesson note and confirmed which branch to take.

---

## Phase 1 — Infrastructure

**Precondition: GATE 0 passed.** If Phase 0 found fan-out broken, skip Tasks 1.1-1.2 entirely and
instead add a single `<id>-notifications` queue that the pipeline writes to with `SendMessage`.
If Phase 0 found only the filter policy broken, omit the `filter_policy` /
`filter_policy_scope` arguments from Task 1.1 Step 2 and keep everything else.

### Task 1.1: Add the SNS topic, the notifications queue and both subscriptions

**Files:**
- Modify: `infra/modules/messaging/main.tf` (append after the existing
  `aws_sqs_queue_redrive_allow_policy.dlq` block, currently ending at line 33)
- Modify: `infra/modules/messaging/variables.tf` (append after
  `message_retention_seconds`, currently ending at line 46)
- Modify: `infra/modules/messaging/outputs.tf` (append after `dlq_arn`, currently ending at line 24)

**Interfaces:**
- Consumes: the module's existing `var.context` object (`{id = string, tags = map(string)}`),
  `aws_sqs_queue.main` (name `${var.context.id}-events`), and `aws_sqs_queue.dlq`.
- Produces: three new module outputs consumed by Task 1.2 —
  `topic_arn` (string, the ARN of `aws_sns_topic.events`),
  `notifications_queue_url` (string, `aws_sqs_queue.notifications.id`),
  `notifications_queue_arn` (string, `aws_sqs_queue.notifications.arn`).
  Two new variables: `notification_event_types` (`list(string)`, default
  `["USER_CREATED", "ORDER_CREATED", "TRACKING_STATUS_CHANGED"]`) and
  `notifications_visibility_timeout_seconds` (`number`, default `60`).

- [ ] **Step 1: Confirm the current module state and get a green baseline**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform validate && terraform plan -no-color | tail -20
```
Expected: `Success! The configuration is valid.` and a plan with **no changes** (or only drift
unrelated to messaging). A dirty baseline makes the next plan unreadable — resolve it first.

- [ ] **Step 2: Add the topic, queue and subscriptions**

Append to `infra/modules/messaging/main.tf`:
```hcl
# ─── SNS fan-out topic ──────────────────────────────────────────────────────────
# The single publish target for all three producers. SQS is point-to-point — each
# message reaches exactly ONE of two competing consumers — so a second consumer on
# the events queue would make emails and notifications each go missing at random.
# See [[2026-09-10-in-app-notifications-design]]
resource "aws_sns_topic" "events" {
  name = "${var.context.id}-events-topic"

  tags = merge(var.context.tags, { Name = "${var.context.id}-events-topic" })
}

# ─── Notifications queue (the Users consumer's own) ─────────────────────────────
# Its own DLQ target is the SHARED dlq: a poison message is a poison message
# whichever consumer choked on it, and a second DLQ doubles the places to triage.
resource "aws_sqs_queue" "notifications" {
  name                       = "${var.context.id}-notifications"
  visibility_timeout_seconds = var.notifications_visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = merge(var.context.tags, { Name = "${var.context.id}-notifications" })
}

# ─── Subscriptions ──────────────────────────────────────────────────────────────
# CONTRACT: raw_message_delivery = true on BOTH subscriptions. Without it SNS wraps
# the body in its own JSON envelope, and the events-pipeline's EnvelopeSchema then
# receives an SNS envelope instead of the domain envelope — every existing handler
# breaks silently. With raw delivery the body is byte-for-byte what the producers
# publish today and the pipeline changes not one line.
# See [[2026-09-10-in-app-notifications-design]]
resource "aws_sns_topic_subscription" "events_queue" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.main.arn
  raw_message_delivery = true
}

# CONTRACT: The filter is on the `type` MESSAGE ATTRIBUTE, not the body — under raw
# delivery the body is opaque to SNS. AUTH_OTP_REQUESTED and PASSWORD_RESET_REQUESTED
# produce no notification and must not arrive at all. The consumer ALSO discards
# unknown types in code, as defence in depth.
resource "aws_sns_topic_subscription" "notifications_queue" {
  topic_arn            = aws_sns_topic.events.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.notifications.arn
  raw_message_delivery = true

  filter_policy_scope = "MessageAttributes"
  filter_policy       = jsonencode({ type = var.notification_event_types })
}

# ─── Queue policies ─────────────────────────────────────────────────────────────
# CONTRACT: Both queues need one. SNS delivery into a queue with no policy naming
# the topic is DROPPED, with no error at the publisher and no message at the
# consumer — the publish reports success either way.
resource "aws_sqs_queue_policy" "main_from_sns" {
  queue_url = aws_sqs_queue.main.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsDelivery"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.main.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}

resource "aws_sqs_queue_policy" "notifications_from_sns" {
  queue_url = aws_sqs_queue.notifications.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowSnsDelivery"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.notifications.arn
      Condition = { ArnEquals = { "aws:SourceArn" = aws_sns_topic.events.arn } }
    }]
  })
}
```

Append to `infra/modules/messaging/variables.tf`:
```hcl
variable "notification_event_types" {
  description = <<-EOT
    Event types the notifications subscription accepts, matched on the `type`
    message attribute. Exactly the three that produce a notification: a WELCOME row
    from USER_CREATED, the ORDER_STATUS/PLACED row from ORDER_CREATED, and the four
    transition ORDER_STATUS rows from TRACKING_STATUS_CHANGED.

    ORDER_CREATED is admitted because it is the "order placed" trigger: PLACED is
    the status a tracking row is CREATED in, never a transition, so it is never
    emitted as a TRACKING_STATUS_CHANGED and a tracking-only policy would deliver
    no order-placed notification at all.

    AUTH_OTP_REQUESTED and PASSWORD_RESET_REQUESTED produce no notification and
    stay out. Adding a type here plus a copy variant is all a future change needs
    — the `type` column is a plain string, not a constrained enum.
  EOT
  type        = list(string)
  default     = ["USER_CREATED", "ORDER_CREATED", "TRACKING_STATUS_CHANGED"]
}

variable "notifications_visibility_timeout_seconds" {
  description = <<-EOT
    Visibility timeout for the notifications queue. Lower than the events queue's
    180 because its consumer is an in-process handler doing one INSERT and one
    best-effort WebSocket push, not a Lambda with a 30s timeout to multiply out.

    60 leaves ample headroom over the handler's real cost while keeping redelivery
    of a genuinely stuck message within a minute. The duplicate that redelivery
    produces is an ACCEPTED outcome here: there is no idempotency key, by
    decision. See [[2026-09-10-in-app-notifications-design]]
  EOT
  type        = number
  default     = 60
}
```

Append to `infra/modules/messaging/outputs.tf`:
```hcl
output "topic_arn" {
  description = "ARN of the SNS fan-out topic (the publish target for all three producers)."
  value       = aws_sns_topic.events.arn
}

output "notifications_queue_url" {
  description = "URL of the notifications SQS queue (consumed in-process by Users)."
  value       = aws_sqs_queue.notifications.id
}

output "notifications_queue_arn" {
  description = "ARN of the notifications SQS queue."
  value       = aws_sqs_queue.notifications.arn
}
```

- [ ] **Step 3: Validate and read the plan**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform validate && terraform plan -no-color | grep -E '^  # |Plan:'
```
Expected: `Success!`, then exactly six additions —
`module.messaging.aws_sns_topic.events`, `module.messaging.aws_sqs_queue.notifications`,
`module.messaging.aws_sns_topic_subscription.events_queue`,
`module.messaging.aws_sns_topic_subscription.notifications_queue`,
`module.messaging.aws_sqs_queue_policy.main_from_sns`,
`module.messaging.aws_sqs_queue_policy.notifications_from_sns` — and
`Plan: 6 to add, 0 to change, 0 to destroy.`

**A plan proposing to REPLACE `aws_sqs_queue.main` is a stop-the-line signal**: replacing the
shared events queue drops every in-flight message and remints its URL. Nothing in Step 2 touches
that resource's arguments, so a replacement means something else drifted — investigate before
applying.

- [ ] **Step 4: Apply and confirm the topology exists**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform apply -auto-approve
aws --endpoint-url http://localhost:4566 sns list-subscriptions-by-topic \
  --topic-arn "$(terraform output -raw events_topic_arn 2>/dev/null || terraform output -raw api_id >/dev/null; echo skip)" 2>/dev/null || true
```
Expected: `Apply complete! Resources: 6 added`. The output read is deferred to Task 1.2, which is
what adds `events_topic_arn` to the root outputs.

- [ ] **Step 5: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** The main session proposes, via the `AskUserQuestion`
A/B/C/D/E menu:

```
feat(infra): SNS fan-out topic and the notifications queue

Adds an SNS topic as the single publish target for all three producers, plus a
<id>-notifications queue subscribed with raw message delivery and a filter policy
on the `type` message attribute admitting USER_CREATED, ORDER_CREATED and
TRACKING_STATUS_CHANGED. Raw delivery keeps the events queue's body byte-for-byte
identical, so the events-pipeline is unchanged.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 1.2: Surface the two new identifiers as root outputs

**Files:**
- Modify: `infra/environments/local/outputs.tf` (append after `events_dlq_url`, which ends at
  line 66)

**Interfaces:**
- Consumes: Task 1.1's module outputs `module.messaging.topic_arn` and
  `module.messaging.notifications_queue_url`.
- Produces: root outputs `events_topic_arn` (string) and `notifications_queue_url` (string),
  read by Task 1.3's `terraform_output(tf_dir, "events_topic_arn")` and
  `terraform_output(tf_dir, "notifications_queue_url")`.

- [ ] **Step 1: Add the two outputs**

Append to `infra/environments/local/outputs.tf`:
```hcl
# The fan-out topic all three producers publish to. Read into every producer's
# generated env file — never hardcoded, because Floci remints the ARN on recreate.
output "events_topic_arn" {
  description = "ARN of the SNS events topic (the publish target for Users, Orders and Tracking)."
  value       = module.messaging.topic_arn
}

# The queue Users consumes in-process. Filtered at the subscription to the two
# notification-producing event types.
output "notifications_queue_url" {
  description = "URL of the notifications SQS queue consumed by the Users service."
  value       = module.messaging.notifications_queue_url
}
```

- [ ] **Step 2: Confirm both outputs resolve non-empty**

This matters more than it looks: `write_env_file` raises `MissingValue` on any empty generated
value, so an output that resolves blank breaks `make env-file` for **every** service, not just
Users.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform apply -auto-approve
terraform output -raw events_topic_arn && echo
terraform output -raw notifications_queue_url && echo
```
Expected: an ARN of the form `arn:aws:sns:us-east-1:000000000000:<id>-events-topic`, and a URL of
the form `http://...:4566/000000000000/<id>-notifications`. Either printing empty is a failure —
outputs are only persisted by an apply that covers their resources, so a `-target`ed apply is the
usual cause.

- [ ] **Step 3: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(infra): expose the events topic ARN and notifications queue URL as outputs

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 1.3: Wire the new values into the env generator

**Files:**
- Modify: `infra/environments/local/scripts/generate_env_files.py`
  - read the outputs: insert after line 234 (`ws_management_endpoint = terraform_output(...)`)
  - `.env.local.users`: insert into `generated={}` after line 344 (`METRICS_INTERVAL_MS`)
  - `.env.local.orders`: insert beside its existing `EVENTS_QUEUE_URL` (line ~384)
  - `.env.local.tracking`: insert beside its existing `EVENTS_QUEUE_URL` (line ~450)
  - `.env.local.debug`: insert beside its existing `EVENTS_QUEUE_URL` (line ~502)

**Interfaces:**
- Consumes: Task 1.2's root outputs `events_topic_arn`, `notifications_queue_url`; and the
  already-read `ws_connections_table`, `ws_connections_gsi`, `ws_management_endpoint`
  (existing lines 232-234 — **these outputs already exist; do not add them**).
- Produces: the env vars Phase 2 and Phase 3 read —
  `.env.local.users` gains `EVENTS_TOPIC_ARN`, `NOTIFICATIONS_QUEUE_URL`,
  `WS_CONNECTIONS_TABLE`, `WS_CONNECTIONS_GSI`, `WS_MANAGEMENT_ENDPOINT`;
  `.env.local.orders`, `.env.local.tracking` and `.env.local.debug` gain `EVENTS_TOPIC_ARN`.
  Every name here must match the Zod schema keys added in Task 2.2 exactly.

- [ ] **Step 1: Read the two new outputs**

Insert into `generate_env_files.py` immediately after line 234:
```python
    # The SNS fan-out topic and the Users-consumed queue. Read, never derived:
    # Floci remints both identifiers whenever the resources are recreated.
    events_topic_arn = terraform_output(tf_dir, "events_topic_arn")
    notifications_queue_url = terraform_output(tf_dir, "notifications_queue_url")
```

- [ ] **Step 2: Add the five Users vars**

Insert into the `.env.local.users` `generated={}` dict, immediately after line 344's
`"METRICS_INTERVAL_MS": METRICS_INTERVAL_MS,`:
```python
                # Users PUBLISHES to the topic and CONSUMES the notifications
                # queue. Both required by its Zod env schema, so the service will
                # not boot without them.
                "EVENTS_TOPIC_ARN": events_topic_arn,
                "NOTIFICATIONS_QUEUE_URL": notifications_queue_url,
                # Realtime push for NOTIFICATION_CREATED. Users resolves
                # user_id -> cognito_sub locally, then queries this GSI for the
                # owner's open sockets.
                "WS_CONNECTIONS_TABLE": ws_connections_table,
                "WS_CONNECTIONS_GSI": ws_connections_gsi,
                # IN-NETWORK (floci:4566) with Floci's undocumented /execute-api/
                # prefix. A wrong shape answers HTTP 400 with an S3 XML body, not
                # an endpoint error.
                # See [[floci-websocket-works]]
                "WS_MANAGEMENT_ENDPOINT": ws_management_endpoint,
```

- [ ] **Step 3: Add `EVENTS_TOPIC_ARN` to the other three producers' files**

In each of `.env.local.orders`, `.env.local.tracking` and `.env.local.debug`, add a line
immediately after that file's existing `"EVENTS_QUEUE_URL": events_queue_url,`:
```python
                # The publish target. EVENTS_QUEUE_URL stays for now so a
                # half-migrated stack still boots; it is removed once every
                # producer reads the topic.
                "EVENTS_TOPIC_ARN": events_topic_arn,
```

- [ ] **Step 4: Regenerate and confirm every file got its vars**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make env-file
grep -c . .env.local.users >/dev/null
echo "── users:" && grep -E 'EVENTS_TOPIC_ARN|NOTIFICATIONS_QUEUE_URL|WS_CONNECTIONS_TABLE|WS_CONNECTIONS_GSI|WS_MANAGEMENT_ENDPOINT' .env.local.users
echo "── orders:" && grep 'EVENTS_TOPIC_ARN' .env.local.orders
echo "── tracking:" && grep 'EVENTS_TOPIC_ARN' .env.local.tracking
echo "── debug:" && grep 'EVENTS_TOPIC_ARN' .env.local.debug
```
Expected: five non-empty `KEY=value` lines for Users and one each for the other three. A
`MissingValue: .env.local.users: required value 'EVENTS_TOPIC_ARN' is empty` means Task 1.2's
output did not persist — go back rather than defaulting the value here.

- [ ] **Step 5: Confirm the CUSTOM box survived regeneration**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
sed -n '/>>> CUSTOM/,/<<< END CUSTOM/p' .env.local.users
```
Expected: the box still carries `PORT`, `GRPC_PORT`, `WEBHOOK_SECRET`, `E2E_TESTING_ENABLED`
and `CACHE_ENABLED` (plus any personal overrides). The AUTO box is rewritten every run and the
CUSTOM box is preserved — a CUSTOM box that lost entries means the writer misread the markers.

- [ ] **Step 6: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(infra): generate the topic ARN, notifications queue and WS vars for Users

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 1.4: Add the three gateway routes (and record why nginx needs nothing)

**Files:**
- Modify: `infra/modules/api-gateway/main.tf` (insert into `local.routes`' base object after
  `delete_cart` at line 112)

**Interfaces:**
- Consumes: the existing `local.routes` entry shape
  `<key> = { key = "<METHOD> <path>", path = "<path>", auth = <bool> }`, the shared
  `aws_apigatewayv2_authorizer.jwt`, and `var.nginx_base_uri`.
- Produces: three reachable gateway routes — `GET /v1/notifications`,
  `GET /v1/notifications/unread-count`, `PATCH /v1/notifications/read` — all
  `auth = true`. Phase 3's routes and Phase 4's API client bind to exactly these paths.

- [ ] **Step 1: Add the three entries**

Insert into `infra/modules/api-gateway/main.tf` after line 112 (`delete_cart = ...`):
```hcl
      # CONTRACT: All three auth = true — every query is scoped to the caller's own
      # user_id, taken from the JWT and never from a parameter or body, so an
      # anonymous notification list has no owner. They are absent from Users'
      # shared/http/public-routes.ts for the same reason, which is what makes the
      # service 401 a request with no x-user-id.
      #
      # No nginx `location` block is needed: /v1/notifications falls under
      # `location /`, which already proxies to Users on 3000 — the same reasoning
      # recorded for /v1/users/me above. A block is required only for a top-level
      # path owned by a DIFFERENT service (/v1/products, /v1/cart, /v1/trackings).
      # See [[2026-09-10-in-app-notifications-design]]
      list_notifications         = { key = "GET /v1/notifications", path = "/v1/notifications", auth = true }
      notifications_unread_count = { key = "GET /v1/notifications/unread-count", path = "/v1/notifications/unread-count", auth = true }
      mark_notifications_read    = { key = "PATCH /v1/notifications/read", path = "/v1/notifications/read", auth = true }
```

- [ ] **Step 2: Validate and confirm exactly three routes are added**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform validate && terraform plan -no-color | grep -E 'notifications|Plan:'
```
Expected: `Success!`, three `aws_apigatewayv2_route.this["...notifications..."]` additions plus
three matching `aws_apigatewayv2_integration.per_route[...]` additions (local mode creates one
integration per route), and `Plan: 6 to add, 0 to change, 0 to destroy.`

- [ ] **Step 3: Apply and prove the routes RESOLVE**

The service does not serve these paths until Phase 3, so the meaningful assertion now is that the
gateway resolves them and reaches the authorizer.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform apply -auto-approve
GW="$(terraform output -raw api_invoke_url)"
for path in "notifications" "notifications/unread-count"; do
  printf '%s -> ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' "$GW/v1/$path"
done
printf 'PATCH notifications/read -> '
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH "$GW/v1/notifications/read"
```
Expected: **401 for all three.** A 401 is the GOOD answer — it proves the route resolved and
reached the authorizer. A **404 carrying the gateway's own `{"message":"Not Found"}`** means the
request never reached the service, i.e. the route is missing from the map.

- [ ] **Step 4: Confirm the routes are NOT public**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -n 'notifications' services/users/src/shared/http/public-routes.ts || echo "correctly absent"
```
Expected: `correctly absent`. Their absence from that allowlist is the only thing making the
`onRequest` hook 401 a caller with no identity — adding them there would leave the inbox
unauthenticated.

- [ ] **Step 5: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(infra): add the three notification routes to the API Gateway route map

All three are auth = true and need no nginx location block — /v1/notifications
falls under `location /`, which already proxies to Users.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 1.5: Record that Users needs no IAM grant locally

**Files:**
- Modify: `infra/environments/local/outputs.tf` (the comment above `ws_management_endpoint`,
  lines 144-145)

**Interfaces:**
- Consumes: nothing.
- Produces: no resource. This task exists because the spec calls for "IAM permission for
  `@connections` and the DynamoDB connections table" for Users, and the honest answer is that
  there is nowhere to attach it — recording that is the deliverable.

- [ ] **Step 1: Confirm Users has no role to attach a policy to**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -rn 'task_role_arn' infra/ || echo "no task role anywhere"
grep -n 'aws_iam_role' infra/modules/compute/main.tf
grep -n 'AWS_ACCESS_KEY_ID' infra/environments/local/scripts/generate_env_files.py | head -3
```
Expected: `no task role anywhere`; the only role in `modules/compute` is
`aws_iam_role.ecs_execution` (used as `execution_role_arn` on the **nginx** task); and the
generator writes static `test`/`test` credentials. Users is a docker-compose service and Floci
performs no IAM authorization, so the SDK calls it makes simply work.

- [ ] **Step 2: Correct the now-stale output comment**

The comment claims the endpoint's only consumer is a Lambda container. Users consumes it too.
Replace lines 144-145 of `infra/environments/local/outputs.tf`:
```hcl
# IN-NETWORK (floci:4566): read into the events-pipeline's environment and into
# .env.local.users. Not host-reachable — both consumers are containers on
# 3mrai-network, which is what makes this shape the correct one for them.
```

- [ ] **Step 3: Validate**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
terraform validate
```
Expected: `Success! The configuration is valid.` (a comment change cannot alter the plan).

- [ ] **Step 4: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
docs(infra): note that Users also consumes the WS management endpoint

Users has no ECS task role — it runs in docker-compose against Floci with static
credentials — so the @connections and DynamoDB grants the events-pipeline Lambda
carries have no local counterpart to attach to. A deployed environment would need
a Users task role created from scratch.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### 🚦 GATE 1 — STOP HERE (dependency gate)

Phase 2 rewrites all three producers to publish to the topic created in Task 1.1, and reads
`EVENTS_TOPIC_ARN` from the env files written in Task 1.3. **Batch Tasks 1.1-1.5 as one list of
open PRs for the user to review and merge, then stop.** Continue to Phase 2 only after they are
merged — a producer that publishes to a topic whose ARN is not yet generated fails at boot
(Orders throws) or degrades to a noop (Tracking warns), and both look like a code bug.

---

## Phase 2 — Producers: SQS `SendMessage` → SNS `Publish`

**Precondition: GATE 1 passed** (the topic exists and `EVENTS_TOPIC_ARN` is in every env file).

**This is the riskiest phase for regression.** The events-pipeline must keep working **unchanged**,
which is exactly what raw message delivery buys. The rule for all three producers: **the envelope
and the `MessageAttributes` are preserved byte-for-byte.** Only the transport changes —
`SendMessage`→`Publish`, `QueueUrl`→`TopicArn`, `MessageBody`→`Message`. Every envelope field name,
every omission rule, every `DataType`, and the deterministic event ids stay exactly as they are.

Three names leak the transport and are asserted or queried somewhere; each is renamed
consistently across code and tests:

| Leak | From | To |
|---|---|---|
| Span name | `sqs.publish <event>` | `sns.publish <event>` |
| Span attribute | `messaging.system = "aws_sqs"` | `messaging.system = "aws_sns"` |
| Failure reason | `sqs_send_failed` | `sns_publish_failed` |

### Task 2.1: Users — swap the publisher to SNS

**Files:**
- Modify: `services/users/package.json` (dependencies)
- Modify: `services/users/src/shared/messaging/event-publisher.ts` (the import at line 1, the
  class at `SqsEventPublisher`, and both `SendMessageCommand` sites at lines ~149 and ~247)
- Modify: `services/users/src/shared/observability/publish-tracing.ts` (the tracer's span name
  and attributes)
- Test: `services/users/tests/shared/event-publisher.test.ts`

**Interfaces:**
- Consumes: `EVENTS_TOPIC_ARN` (string) from `env` — added to the Zod schema in Task 2.2, which
  runs first if the two are split; `withPublishSpan(eventType: string, fn: (span: PublishSpan) =>
  Promise<T>): Promise<T>` from `#shared/observability/publish-tracing`;
  `NanoIdConfig.newEventId(): string`; `AuditActor` enum; `getLogContext(): LogContextStore`;
  `hashEmail(email: string): string`.
- Produces:
  - `export class SnsEventPublisher implements EventPublisher` with
    `constructor(client: SNSClient, topicArn: string)` and the two unchanged methods
    `publishUserCreated(payload: UserCreatedPayload): Promise<void>` and
    `publishPasswordResetRequested(payload: PasswordResetRequestedPayload): Promise<void>`.
  - `NoopEventPublisher`, `EventPublisher`, `UserCreatedPayload`, `PasswordResetRequestedPayload`
    are **unchanged** and keep their exported names.
  - Task 2.2 registers `snsClient` and this class in the Awilix container.

- [ ] **Step 1: Write the failing test**

Replace `services/users/tests/shared/event-publisher.test.ts` with:
```ts
import { describe, it, expect } from "vitest";
import { PublishCommand } from "@aws-sdk/client-sns";
import { NoopEventPublisher, SnsEventPublisher } from "#shared/messaging/event-publisher";

const TOPIC_ARN = "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic";

// Records what was published without reaching a transport. Typed as the narrow
// shape the publisher actually uses, so the fake cannot drift from the real client.
function recordingClient() {
  const sent: PublishCommand[] = [];
  return {
    sent,
    client: {
      send: async (command: PublishCommand) => {
        sent.push(command);
        return {};
      },
    } as never,
  };
}

describe("SnsEventPublisher", () => {
  it("publishes USER_CREATED to the topic with the envelope and attributes intact", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishUserCreated({
      id: "usr_a",
      email: "a@b.c",
      fullName: "A B",
      createdAt: new Date("2026-01-15T10:30:00.000Z"),
      cognitoSub: "sub-123",
    });

    expect(sent).toHaveLength(1);
    const input = sent[0]!.input;

    // TopicArn replaces QueueUrl; Message replaces MessageBody.
    expect(input.TopicArn).toBe(TOPIC_ARN);
    expect(input.QueueUrl).toBeUndefined();

    // CONTRACT: The envelope is preserved byte-for-byte across the transport
    // change. Asserting the parsed OBJECT (not a substring) is what catches a
    // dropped or renamed key.
    const envelope = JSON.parse(input.Message as string);
    expect(envelope).toMatchObject({
      type: "USER_CREATED",
      source: "users",
      user_id: "usr_a",
      order_id: null,
      author: { actor: "users_api:register", user_id: "usr_a", cognito_sub: "sub-123" },
      payload: {
        email: "a@b.c",
        fullName: "A B",
        userId: "usr_a",
        createdAt: "2026-01-15T10:30:00.000Z",
      },
    });
    expect(envelope.event_id).toMatch(/^evt_/);

    // CONTRACT: `request_id` is OMITTED outside a request, never null — the
    // pipeline declares it .optional().min(1), so a null is a PermanentError.
    expect("request_id" in envelope).toBe(false);

    expect(input.MessageAttributes).toMatchObject({
      type: { DataType: "String", StringValue: "USER_CREATED" },
      source: { DataType: "String", StringValue: "users" },
    });
  });

  it("omits author.cognito_sub when the caller has none", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishUserCreated({
      id: "usr_b",
      email: "b@c.d",
      fullName: "B C",
      createdAt: new Date("2026-01-15T10:30:00.000Z"),
    });

    const envelope = JSON.parse(sent[0]!.input.Message as string);
    expect("cognito_sub" in envelope.author).toBe(false);
  });

  it("publishes PASSWORD_RESET_REQUESTED without leaking the code into attributes", async () => {
    const { sent, client } = recordingClient();
    const publisher = new SnsEventPublisher(client, TOPIC_ARN);

    await publisher.publishPasswordResetRequested({
      userId: "usr_c",
      email: "c@d.e",
      fullName: "C D",
      code: "042817",
      ttlSeconds: 600,
    });

    const input = sent[0]!.input;
    const envelope = JSON.parse(input.Message as string);
    expect(envelope.type).toBe("PASSWORD_RESET_REQUESTED");
    expect(envelope.payload).toMatchObject({
      email: "c@d.e",
      full_name: "C D",
      code: "042817",
      ttlSeconds: 600,
    });
    // WARNING: the code is a live credential — it rides the body only.
    expect(JSON.stringify(input.MessageAttributes)).not.toContain("042817");
  });

  it("swallows a publish failure rather than failing the caller", async () => {
    const failing = {
      send: async () => {
        throw new Error("topic unreachable");
      },
    } as never;
    const publisher = new SnsEventPublisher(failing, TOPIC_ARN);

    // The user row and Cognito account already exist, so a throw here would
    // report an error for a registration that succeeded.
    await expect(
      publisher.publishUserCreated({
        id: "usr_d",
        email: "d@e.f",
        fullName: "D E",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("NoopEventPublisher", () => {
  it("resolves without throwing", async () => {
    const pub = new NoopEventPublisher();
    await expect(
      pub.publishUserCreated({
        id: "usr_a",
        email: "a@b.c",
        fullName: "A B",
        createdAt: new Date("2026-01-15T10:30:00.000Z"),
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- event-publisher
```
Expected: FAIL — `Cannot find module '@aws-sdk/client-sns'` (the package is not installed), and
once that resolves, `SnsEventPublisher is not exported by #shared/messaging/event-publisher`.

- [ ] **Step 3: Install the SNS client**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users add @aws-sdk/client-sns
```
Expected: `@aws-sdk/client-sns` added to `services/users/package.json` dependencies. **pnpm only** —
`npm install` here corrupts the workspace tree and leaves a stray `package-lock.json`.

Keep `@aws-sdk/client-sqs`: Task 3.5's consumer still receives from a queue, so the SQS client
remains a real dependency rather than a leftover.

- [ ] **Step 4: Swap the transport in the publisher**

In `services/users/src/shared/messaging/event-publisher.ts`, replace line 1:
```ts
import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
```

Rename the class and its constructor (the doc comment above it is unchanged — the `event_id`
idempotency contract still holds):
```ts
export class SnsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SNSClient,
    private readonly topicArn: string,
  ) {}
```

In **both** `publishUserCreated` and `publishPasswordResetRequested`, replace the send call.
`publishUserCreated`:
```ts
        await this.client.send(
          new PublishCommand({
            TopicArn: this.topicArn,
            Message: JSON.stringify(envelope),
            // CONTRACT: These survive raw message delivery, which is what keeps
            // the traceparent joined across the topic and lets the notifications
            // subscription filter on `type`. Duplicated from the body so a queue
            // can be inspected and filtered without deserializing it.
            MessageAttributes: {
              type: { DataType: "String", StringValue: envelope.type },
              source: { DataType: "String", StringValue: envelope.source },
              // CONTRACT: Built HERE, inside the span — see traceparentAttributes.
              ...traceparentAttributes(),
            },
          }),
        );
```
`publishPasswordResetRequested` takes the identical replacement, with its own
`envelope.type`/`envelope.source` (both already read from the local `envelope`).

Update the two failure log lines' `reason` in the same file, from `"sqs_send_failed"` to
`"sns_publish_failed"` — the string is machine-readable and names the hop that broke.

- [ ] **Step 5: Rename the span to match the transport**

In `services/users/src/shared/observability/publish-tracing.ts`, update the first CONTRACT
comment's example and the span construction:
```ts
// CONTRACT: Each service names its own publish span after the EVENT TYPE
// (`sns.publish order_created` in Orders is the reference shape). The AWS SDK's
// own `<topic> publish` span names the one part of the hop that never varies —
// every event goes to the same topic — so it cannot say what was published. It is
// not suppressed: it stays a CHILD, answering "how did the call to SNS go".
// See [[logging-context]]
```
and inside `withPublishSpan`:
```ts
    `sns.publish ${eventType}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "aws_sns",
        "messaging.operation": "publish",
        "messaging.destination.kind": "topic",
        event_type: eventType,
      },
    },
```

- [ ] **Step 6: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- event-publisher
```
Expected: PASS, 5 tests.

- [ ] **Step 7: Confirm nothing else still imports the old name**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -rn 'SqsEventPublisher\|SendMessageCommand' services/users/src services/users/tests || echo "no stale references"
nvm use && pnpm --filter users build
```
Expected: `no stale references` — except `awilix-container.ts`, which Task 2.2 updates; if that is
the only hit, proceed. The build must succeed.

- [ ] **Step 8: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
refactor(users)!: publish events to SNS instead of SQS

SendMessageCommand -> PublishCommand, EVENTS_QUEUE_URL -> EVENTS_TOPIC_ARN. The
envelope, both payloads and the MessageAttributes are unchanged byte-for-byte, so
the events-pipeline consumes them exactly as before under raw message delivery.

BREAKING CHANGE: Users now requires EVENTS_TOPIC_ARN.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 2.2: Users — register the SNS client and the new env vars

**Files:**
- Modify: `services/users/src/shared/config/env.ts` (the `schema` object; `EVENTS_QUEUE_URL` is at
  line 42)
- Modify: `services/users/src/shared/di/awilix-container.ts` (the import at line 3, the `Cradle`
  interface, and the `sqsClient`/`events` registrations)
- Modify: `services/users/vitest.config.ts` (the `test.env` block)
- Test: `services/users/tests/shared/env.test.ts`

**Interfaces:**
- Consumes: `SnsEventPublisher` from Task 2.1 with
  `constructor(client: SNSClient, topicArn: string)`.
- Produces:
  - `Env` gains `EVENTS_TOPIC_ARN: string`, `NOTIFICATIONS_QUEUE_URL: string`,
    `WS_MANAGEMENT_ENDPOINT: string`, `WS_CONNECTIONS_TABLE: string`,
    `WS_CONNECTIONS_GSI: string`. Names match Task 1.3's generated keys exactly.
  - `Cradle` gains `snsClient: SNSClient` and keeps `sqsClient: SQSClient` (the consumer needs
    it). `events: EventPublisher` now resolves `SnsEventPublisher`.
  - Task 3.5 resolves `sqsClient` and `env.NOTIFICATIONS_QUEUE_URL`; Task 3.6 resolves
    `env.WS_MANAGEMENT_ENDPOINT`, `env.WS_CONNECTIONS_TABLE`, `env.WS_CONNECTIONS_GSI`.

- [ ] **Step 1: Write the failing test**

Append to `services/users/tests/shared/env.test.ts`:
```ts
describe("notification env vars", () => {
  // The base of a valid environment, mirroring vitest.config.ts's test.env.
  function baseEnv(): Record<string, string> {
    return {
      DATABASE_WRITER_URL: "postgres://user:pass@localhost:5432/users",
      DATABASE_READER_URL: "postgres://user:pass@localhost:5432/users",
      COGNITO_USER_POOL_ID: "us-east-1_dummy",
      COGNITO_CLIENT_ID: "dummy_client",
      AWS_ENDPOINT_URL: "http://localhost:4566",
      AWS_REGION: "us-east-1",
      WEBHOOK_SECRET: "test-webhook-secret",
      GRPC_API_KEY: "test-grpc-key",
      ORDERS_BASE_URL: "http://localhost:8080",
      TRACKING_BASE_URL: "http://localhost:8000",
      REDIS_HOST: "localhost",
      REDIS_PORT: "6379",
      EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic",
      NOTIFICATIONS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-notifications",
      WS_MANAGEMENT_ENDPOINT: "http://floci:4566/execute-api/abc123/$default",
      WS_CONNECTIONS_TABLE: "3mrai-local-realtime-ws-connections",
      WS_CONNECTIONS_GSI: "by-cognito-sub",
    };
  }

  it("parses the five notification vars", () => {
    const env = parseEnv(baseEnv());
    expect(env.EVENTS_TOPIC_ARN).toContain("arn:aws:sns");
    expect(env.NOTIFICATIONS_QUEUE_URL).toContain("notifications");
    expect(env.WS_MANAGEMENT_ENDPOINT).toContain("execute-api");
    expect(env.WS_CONNECTIONS_TABLE).toContain("ws-connections");
    expect(env.WS_CONNECTIONS_GSI).toBe("by-cognito-sub");
  });

  // CONTRACT: Required with no default. A missing value must fail at BOOT with a
  // named Zod error — a defaulted topic ARN publishes into the void and every
  // notification is silently lost. See [[ADR-0014-env-validation-zod]]
  it.each([
    "EVENTS_TOPIC_ARN",
    "NOTIFICATIONS_QUEUE_URL",
    "WS_MANAGEMENT_ENDPOINT",
    "WS_CONNECTIONS_TABLE",
  ])("fails to boot without %s", (key) => {
    const source = baseEnv();
    delete source[key];
    expect(() => parseEnv(source)).toThrow(new RegExp(key));
  });

  // The one that MAY default: the GSI name is a Terraform constant, not a minted id.
  it("defaults WS_CONNECTIONS_GSI to by-cognito-sub", () => {
    const source = baseEnv();
    delete source.WS_CONNECTIONS_GSI;
    expect(parseEnv(source).WS_CONNECTIONS_GSI).toBe("by-cognito-sub");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- env
```
Expected: FAIL — `expected undefined to contain 'arn:aws:sns'`, because the schema does not yet
declare the keys and Zod strips unknown ones.

- [ ] **Step 3: Add the five keys to the Zod schema**

In `services/users/src/shared/config/env.ts`, replace the `EVENTS_QUEUE_URL` entry (line 42 and
its comment) with:
```ts
  // CONTRACT: The SNS fan-out topic all three producers publish to, required with
  // no default — a defaulted ARN publishes into the void and loses every event
  // silently. `make env-file` writes it from the Terraform output because Floci
  // remints the ARN whenever the topic is recreated.
  // See [[env-files]] and [[ADR-0014-env-validation-zod]]
  EVENTS_TOPIC_ARN: z.string().min(1),
  // The queue this service CONSUMES in-process (see features/notifications).
  // Filtered at the SNS subscription to the two notification-producing types.
  NOTIFICATIONS_QUEUE_URL: z.string().url(),
  // CONTRACT: The IN-NETWORK @connections endpoint (floci:4566) carrying Floci's
  // undocumented /execute-api/{apiId}/{stage} prefix — NOT a host URL, and not
  // parsed as one: the `$default` stage segment is legal here. A wrong shape
  // answers HTTP 400 with an S3 XML body, which looks nothing like an endpoint
  // problem. See [[floci-websocket-works]]
  WS_MANAGEMENT_ENDPOINT: z.string().min(1),
  // The connections registry the realtime push queries.
  WS_CONNECTIONS_TABLE: z.string().min(1),
  // CONTRACT: The GSI is keyed by `cognito_sub`, never `user_id`. Querying it with
  // an internal usr_ id returns zero rows and NO error, which reads exactly like
  // "the user has nothing open". Defaulted because the name is a Terraform
  // constant, unlike the minted identifiers above.
  // See [[user-id-vs-cognito-sub-ownership-key]]
  WS_CONNECTIONS_GSI: z.string().min(1).default("by-cognito-sub"),
```

- [ ] **Step 4: Register the SNS client in the container**

In `services/users/src/shared/di/awilix-container.ts`, add the import beside the SQS one at line 3:
```ts
import { SNSClient } from "@aws-sdk/client-sns";
```
Change the publisher import:
```ts
import { SnsEventPublisher, type EventPublisher } from "../messaging/event-publisher.ts";
```
Add to the `Cradle` interface, beside `sqsClient`:
```ts
    snsClient: SNSClient;
```
Add the client registration beside `sqsClient` (keeping `sqsClient` — the consumer receives from a
queue):
```ts
    snsClient: asFunction(
      ({ env: cradleEnv }: { env: Env }) =>
        new SNSClient({
          region: cradleEnv.AWS_REGION,
          endpoint: cradleEnv.AWS_ENDPOINT_URL,
        }),
      { lifetime: Lifetime.SINGLETON },
    ),
```
Replace the `events` registration:
```ts
    events: asFunction(
      ({ snsClient, env: cradleEnv }: { snsClient: SNSClient; env: Env }) =>
        new SnsEventPublisher(snsClient, cradleEnv.EVENTS_TOPIC_ARN),
      { lifetime: Lifetime.SINGLETON },
    ),
```

- [ ] **Step 5: Add the vars to the test env**

In `services/users/vitest.config.ts`, replace the `EVENTS_QUEUE_URL` line in `test.env` with:
```ts
      EVENTS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic",
      NOTIFICATIONS_QUEUE_URL: "http://localhost:4566/000000000000/3mrai-local-notifications",
      // Required by the env schema, so the whole suite fails to import without
      // them. No socket is opened here: the realtime clients are built lazily by
      // the Awilix SINGLETON and no unit test resolves them.
      WS_MANAGEMENT_ENDPOINT: "http://localhost:4566/execute-api/test/$default",
      WS_CONNECTIONS_TABLE: "3mrai-test-ws-connections",
      WS_CONNECTIONS_GSI: "by-cognito-sub",
```

- [ ] **Step 6: Run the whole Users suite and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test && pnpm --filter users build && pnpm --filter users lint
```
Expected: all tests pass, `tsc` succeeds, eslint is clean. A failure naming `EVENTS_QUEUE_URL`
means a call site still reads the removed key — `grep -rn 'EVENTS_QUEUE_URL' services/users/src`
finds it.

- [ ] **Step 7: Confirm Users boots and publishes end to end**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
docker compose up -d --build users
sleep 5
docker compose logs users --tail 30
curl -s -X POST http://localhost:3000/v1/users/register \
  -H 'content-type: application/json' -H 'x-e2e-source: true' \
  -d '{"email":"sns-probe@example.test","password":"Passw0rd!23","fullName":"SNS Probe"}' \
  -o /dev/null -w 'register -> %{http_code}\n'
docker compose logs users --tail 20 | grep -E 'user_created_published|publish_failed' || true
```
Expected: the service boots with no Zod error, register answers **201**, and the logs carry
`app_event: "user_created_published"`. A `user_created_publish_failed` with
`reason: "sns_publish_failed"` means the topic ARN or the queue policy is wrong — the publish is
swallowed by design, so the log line is the only signal.

- [ ] **Step 8: Confirm the pipeline still receives the event unchanged**

This is the regression that matters most in this phase.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
docker compose logs users --tail 5 >/dev/null
aws --endpoint-url http://localhost:4566 logs tail "/aws/lambda/$(cd infra/environments/local && terraform output -raw events_lambda_function_name)" --since 5m 2>/dev/null | tail -30
```
Expected: the pipeline logs show the record processed and the welcome email sent — **no
`EnvelopeSchema` validation failure.** A validation error naming `Message`, `MessageAttributes` or
`Type` is the signature of raw message delivery being off: SNS wrapped the body in its own
envelope. Fix the subscription, not the pipeline.

- [ ] **Step 9: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): register the SNS client and the notification env vars

Adds EVENTS_TOPIC_ARN, NOTIFICATIONS_QUEUE_URL, WS_MANAGEMENT_ENDPOINT,
WS_CONNECTIONS_TABLE and WS_CONNECTIONS_GSI to the Zod schema, all required with
no default except the GSI name. Keeps the SQS client — the notifications consumer
receives from a queue.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 2.3: Orders — swap the publisher to SNS

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Messaging/SnsEventPublisher.cs`
- Delete: `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs`
- Modify: `services/orders/src/Orders.Infrastructure/Orders.Infrastructure.csproj` (line 15)
- Modify: `services/orders/src/Orders.Api/Program.cs` (line 2, line 60, lines 206-241)
- Test: `services/orders/tests/Orders.Tests/Messaging/SnsEventPublisherTests.cs` (renamed from
  `SqsEventPublisherTests.cs`, 818 lines)

**Interfaces:**
- Consumes: `IEventPublisher` from `Orders.Application.Abstractions` — its 14-parameter
  `PublishOrderCreatedAsync` signature is **unchanged**; `OrderCreatedItem`;
  `NanoIdConfig.EventPrefix`; `AuditActor.CreateOrder`; `AmbientRequestId.Current`.
- Produces:
  - `public class SnsEventPublisher : IEventPublisher` in `Orders.Infrastructure.Messaging`,
    with `public SnsEventPublisher(IAmazonSimpleNotificationService client, string topicArn,
    ILogger<SnsEventPublisher> logger)`.
  - `public const string ActivitySourceName = "orders-messaging"` (**unchanged** — it names the
    service's messaging source, not the transport, and `Program.cs`'s `AddSource` depends on it).
  - `public const string PublishActivityName = "sns.publish order_created"`.
  - Every private envelope record (`EventEnvelope`, `EventAuthor`, `OrderCreatedPayload`,
    `OrderNumberPayload`, `OrderCreatedItemPayload`) is carried over **unchanged**, wire names
    included.
  - `NoopEventPublisher` is untouched.

- [ ] **Step 1: Write the failing test**

`git mv` the test file to `SnsEventPublisherTests.cs`, then apply these four mechanical edits
throughout its 818 lines. Everything else — every envelope assertion, every omission test — stays
exactly as written, which is the point: they are what prove the wire shape did not move.

1. Replace the usings:
```csharp
using Amazon.SimpleNotificationService;
using Amazon.SimpleNotificationService.Model;
```
2. Replace the class name `SqsEventPublisherTests` → `SnsEventPublisherTests` and the constant
   `QueueUrl` → `TopicArn`:
```csharp
    private const string TopicArn = "arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic";
```
3. Replace the `Build` helper (lines ~73-79) and the `RecordingSqs` fake (lines ~760-785):
```csharp
    private static (SnsEventPublisher Publisher, RecordingSns Sns, CapturingLogger Logger) Build(
        Exception? sendFailure = null)
    {
        var sns = new RecordingSns(sendFailure);
        var logger = new CapturingLogger();
        return (new SnsEventPublisher(sns.Object, TopicArn, logger), sns, logger);
    }
```
```csharp
    // Records what was published without reaching a transport. MockBehavior.Strict
    // so an unexpected SDK call fails the test rather than returning a default.
    private sealed class RecordingSns
    {
        public RecordingSns(Exception? failure)
        {
            var mock = new Mock<IAmazonSimpleNotificationService>(MockBehavior.Strict);
            var setup = mock
                .Setup(s => s.PublishAsync(It.IsAny<PublishRequest>(), It.IsAny<CancellationToken>()))
                .Callback<PublishRequest, CancellationToken>((req, _) => Requests.Add(req));

            if (failure is null)
            {
                setup.ReturnsAsync(new PublishResponse());
            }
            else
            {
                setup.ThrowsAsync(failure);
            }

            Object = mock.Object;
        }

        public List<PublishRequest> Requests { get; } = new();

        public IAmazonSimpleNotificationService Object { get; }
    }
```
4. Replace every assertion reading the body and every thrown exception:
   - `sqs.Requests.Single().MessageBody` → `sns.Requests.Single().Message`
   - `new AmazonSQSException("queue unreachable")` →
     `new AmazonSimpleNotificationServiceException("topic unreachable")` (at the three sites)
   - the `reason` assertion `"sqs_send_failed"` → `"sns_publish_failed"`
   - any assertion on `QueueUrl` → `TopicArn`

Add one new test asserting the transport swap explicitly:
```csharp
    [Fact]
    public async Task PublishesToTheTopicRatherThanAQueue()
    {
        var (publisher, sns, _) = Build();

        await publisher.PublishOrderCreatedAsync(
            "ord_1", "3MRAI10482", "usr_1", "a@b.c", "A B",
            1000, 80, 500, 1580, null, Array.Empty<OrderCreatedItem>(),
            new DateTime(2026, 1, 15, 10, 30, 0, DateTimeKind.Utc));

        var request = sns.Requests.Single();
        Assert.Equal(TopicArn, request.TopicArn);
        // CONTRACT: The envelope is preserved byte-for-byte across the transport
        // change — the pipeline's Zod schema validates this exact object.
        using var document = JsonDocument.Parse(request.Message);
        Assert.Equal("ORDER_CREATED", document.RootElement.GetProperty("type").GetString());
        Assert.Equal("orders", document.RootElement.GetProperty("source").GetString());
        Assert.Equal(
            "ORDER_CREATED",
            request.MessageAttributes["type"].StringValue);
    }
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
dotnet test services/orders/Orders.sln --filter FullyQualifiedName~SnsEventPublisher
```
Expected: FAIL to compile — `The type or namespace name 'SimpleNotificationService' does not exist
in the namespace 'Amazon'` (the package is not referenced) and
`The type or namespace name 'SnsEventPublisher' could not be found`.

- [ ] **Step 3: Reference the SNS package on the v4 line**

**CONTRACT: the v4 line, not v3.** The csproj records that mixing v3 and v4 AWS SDK packages in
one project causes assembly-binding conflicts, and that each service package versions
independently — so the patch number cannot be copied from `AWSSDK.SQS`.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/services/orders/src/Orders.Infrastructure
dotnet add package AWSSDK.SimpleNotificationService --version 4.0.*
grep -n 'AWSSDK' Orders.Infrastructure.csproj
```
Expected: a pinned `4.0.x` version in the csproj beside the other two. Verify the resolved version
is `4.0.*` and **not** a `3.7.*` float — a v3 resolution is the failure this step guards against.
Then replace `AWSSDK.SQS` with the new reference, keeping the existing comment above it (it applies
verbatim to the new package):
```xml
    <PackageReference Include="AWSSDK.CloudWatch" Version="4.0.101" />
    <PackageReference Include="AWSSDK.SimpleNotificationService" Version="4.0.*" />
```

- [ ] **Step 4: Create the SNS publisher**

`git mv` `SqsEventPublisher.cs` to `SnsEventPublisher.cs`, then apply exactly these edits. Every
comment, every record, and every envelope field stays as written.

Replace the usings:
```csharp
using Amazon.SimpleNotificationService;
using Amazon.SimpleNotificationService.Model;
```
Rename the class, its constants, its fields and its constructor:
```csharp
public class SnsEventPublisher : IEventPublisher
{
    private const string EventIdPrefix = NanoIdConfig.EventPrefix;
    private const string EventType = "ORDER_CREATED";
    private const string EventSource = "orders";
```
```csharp
    /// <summary>The publish span's name, asserted by the tests that pin the trace hop.</summary>
    public const string PublishActivityName = "sns.publish order_created";
```
```csharp
    private readonly IAmazonSimpleNotificationService _client;
    private readonly string _topicArn;
    private readonly ILogger<SnsEventPublisher> _logger;

    public SnsEventPublisher(
        IAmazonSimpleNotificationService client,
        string topicArn,
        ILogger<SnsEventPublisher> logger)
    {
        _client = client;
        _topicArn = topicArn;
        _logger = logger;
    }
```
**Leave `ActivitySourceName` as `"orders-messaging"`** — it names this service's messaging source,
not its transport, and `Program.cs`'s `AddSource` registration is keyed on it.

Replace the request construction and send (lines ~129-148):
```csharp
        var request = new PublishRequest
        {
            TopicArn = _topicArn,
            Message = JsonSerializer.Serialize(envelope, SerializerOptions),
        };

        // CONTRACT: Start the activity OUTSIDE the try, with the try/catch nested in its
        // scope. Inside the try, an exception disposes it on the way out and the failure log
        // lands on the enclosing workflow span, invisible to a span-scoped lookup on the
        // publish. See [[logging-context]]
        using var activity = Source.StartActivity(PublishActivityName, ActivityKind.Producer);

        try
        {
            // CONTRACT: Build the attributes here, inside the activity's scope. Evaluated in
            // the request initializer above, Activity.Current is the enclosing create_order
            // span and the consumer parents its work to that instead of to this send.
            request.MessageAttributes = BuildMessageAttributes();

            await _client.PublishAsync(request, ct);
```
Change the failure `reason` in the catch block from `"sqs_send_failed"` to `"sns_publish_failed"`.

Change `BuildMessageAttributes`'s return type — `Amazon.SQS.Model.MessageAttributeValue` and
`Amazon.SimpleNotificationService.Model.MessageAttributeValue` are distinct types — while the body
is unchanged:
```csharp
    // CONTRACT: Call this INSIDE the publish activity's scope — it reads Activity.Current.
    // Called while building the PublishRequest, it captures the enclosing create_order
    // span and the consumer parents process_record as a sibling of the send, so expanding
    // the publish shows only SDK internals. Omit traceparent when there is no activity:
    // SNS rejects an empty StringValue, turning a missing trace into a failed publish.
    // It rides in the attributes, never in the body, which the consumer's schema validates.
    // See [[ADR-0019-distributed-tracing-opentelemetry]]
    private static Dictionary<string, MessageAttributeValue> BuildMessageAttributes()
```

- [ ] **Step 5: Register the SNS client**

In `services/orders/src/Orders.Api/Program.cs`, replace line 2:
```csharp
using Amazon.SimpleNotificationService;
```
Update line 60:
```csharp
        .AddSource(SnsEventPublisher.ActivitySourceName)
```
Replace lines 206-241:
```csharp
// CONTRACT: Fail fast on missing EVENTS_TOPIC_ARN — a null ARN boots silently and the publisher
// swallows publish failures, so no confirmation email is ever sent.
// WORKAROUND(local): Exempt during GetDocument.Insider — no env file at `dotnet build` time.
// See [[env-files]]
var eventsTopicArn = builder.Configuration["EVENTS_TOPIC_ARN"]
    ?? (isDocumentGeneration
        ? string.Empty
        : throw new InvalidOperationException(
            "EVENTS_TOPIC_ARN is not set. It is generated into .env.local.orders by "
            + "`make env-file`; see docs/shared/conventions/env-files.md."));
// One SNS client per process (Singleton) — it owns an HTTP connection pool, so a
// per-request client would build and discard one on every order.
builder.Services.AddSingleton<IAmazonSimpleNotificationService>(_ =>
{
    var config = new AmazonSimpleNotificationServiceConfig
    {
        // Region must be set explicitly: locally there is no EC2/ECS metadata to
        // infer one from, and the SDK throws rather than defaulting.
        RegionEndpoint = Amazon.RegionEndpoint.GetBySystemName(
            builder.Configuration["AWS_REGION"] ?? "us-east-1"),
    };

    // Only set locally (Floci); in AWS the variable is absent and the SDK resolves
    // the real regional endpoint itself.
    var endpointUrl = builder.Configuration["AWS_ENDPOINT_URL"];
    if (!string.IsNullOrWhiteSpace(endpointUrl))
    {
        config.ServiceURL = endpointUrl;
    }

    return new AmazonSimpleNotificationServiceClient(config);
});
builder.Services.AddScoped<IEventPublisher>(sp => new SnsEventPublisher(
    sp.GetRequiredService<IAmazonSimpleNotificationService>(),
    eventsTopicArn,
    sp.GetRequiredService<ILogger<SnsEventPublisher>>()));
```

- [ ] **Step 6: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
dotnet test services/orders/Orders.sln --filter FullyQualifiedName~SnsEventPublisher
```
Expected: PASS. The 818 lines of envelope assertions passing unchanged is the evidence that the
wire shape survived the transport swap — that is what this file is for.

- [ ] **Step 7: Confirm no stale SQS references and the whole suite is green**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -rn 'IAmazonSQS\|SendMessageRequest\|AmazonSQSException\|SqsEventPublisher\|EVENTS_QUEUE_URL' services/orders/src services/orders/tests || echo "no stale references"
dotnet test services/orders/Orders.sln
```
Expected: `no stale references`, and the full suite green (Testcontainers needs Docker running).

- [ ] **Step 8: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
refactor(orders)!: publish ORDER_CREATED to SNS instead of SQS

IAmazonSQS/SendMessageRequest -> IAmazonSimpleNotificationService/PublishRequest,
EVENTS_QUEUE_URL -> EVENTS_TOPIC_ARN. The envelope records and their wire names are
unchanged, which the publisher's existing 818-line test suite verifies unaltered.

BREAKING CHANGE: Orders now requires EVENTS_TOPIC_ARN and throws at boot without it.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 2.4: Tracking — swap the publisher to SNS

**Files:**
- Modify: `services/tracking-go/internal/adapter/sqs/publisher.go` (imports at lines 21-22,
  `PublishSpanName` at line 38, `SendMessageAPI` at lines 47-49, the struct at lines 71-76,
  `NewPublisher` at line 79, the guard at line 91, the span attribute at line 123, the send at
  lines 131-144, `buildMessageAttributes` at lines 274-292)
- Modify: `services/tracking-go/internal/platform/config/config.go` (the field at lines 41-43,
  the load at line 118)
- Modify: `services/tracking-go/cmd/server/main.go` (the import at line 30, the options at
  lines 178-184, the publisher switch at lines 244-261)
- Modify: `services/tracking-go/go.mod` / `go.sum`
- Test: `services/tracking-go/internal/adapter/sqs/publisher_test.go`
- Test: `services/tracking-go/cmd/server/main_test.go` (line 48)

**Interfaces:**
- Consumes: `StatusChanged`, `envelope`, `author`, `payload`, `orderNumber`, `historyEntry`,
  `DeriveEventID(orderID, status string) string`, `EventType`, `EventSource`, `timestampLayout`
  — all from `envelope.go`, which is **transport-agnostic and needs zero changes**;
  `grpcusers.ResolvedUser`; `audit.Actor`.
- Produces:
  - `type PublishAPI interface { Publish(ctx context.Context, in *awssns.PublishInput, opts ...func(*awssns.Options)) (*awssns.PublishOutput, error) }` — replaces `SendMessageAPI`.
  - `func NewPublisher(client PublishAPI, topicARN string, resolve UserResolver, log *slog.Logger) Publisher` — same shape, second parameter renamed.
  - `const PublishSpanName = "sns.publish tracking_status_changed"`.
  - `func buildMessageAttributes(ctx context.Context) map[string]snstypes.MessageAttributeValue`.
  - `Publisher`, `NewNoopPublisher`, `UserResolver` and `PublishTrackingStatusChanged`'s
    signature are **unchanged**, so `notify.StatusEventPublisher` and `wire_app.go` need no edit.
  - `config.Config` gains `EventsTopicARN string` in place of `EventsQueueURL`.

**Package name:** stays `sqs`. **CONTRACT:** `cmd/server/wiring_reachability_test.go:40` pins the
package path as `pkgSQS = modulePath + "/internal/adapter/sqs"` and asserts at line 99 that the
composition root still calls `NewPublisher`. Renaming the directory means editing that inventory in
the same change; the transport swap does not require it, so the package keeps its name and the
guard keeps working. Note this in the package doc comment.

- [ ] **Step 1: Write the failing test**

Apply these edits to `services/tracking-go/internal/adapter/sqs/publisher_test.go`. The envelope
tests (`TestEnvelopeShape`, `TestOmissionRules`, `TestEnvelopeCarriesBothFormsOfTheOrderNumber`,
`TestAnOrderWithoutANumberOmitsTheKey`, `TestEventIDIsDeterministic`,
`TestEnvelopeEventIDMatchesDerive`, `TestActorIsThreadedThroughNotConstant`, `TestNoPIIIsLogged`)
keep their bodies unchanged — they read the recorded body, and that body must not move.

Replace the recording fake and its imports:
```go
import (
	awssns "github.com/aws/aws-sdk-go-v2/service/sns"
	snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
)

// recordingSNS captures each publish without reaching a transport.
type recordingSNS struct {
	inputs []*awssns.PublishInput
	err    error
}

func (r *recordingSNS) Publish(
	_ context.Context, in *awssns.PublishInput, _ ...func(*awssns.Options),
) (*awssns.PublishOutput, error) {
	r.inputs = append(r.inputs, in)
	if r.err != nil {
		return nil, r.err
	}
	return &awssns.PublishOutput{}, nil
}

// body returns the single published envelope as raw JSON.
func (r *recordingSNS) body(t *testing.T) []byte {
	t.Helper()
	if len(r.inputs) != 1 {
		t.Fatalf("published %d messages, want 1", len(r.inputs))
	}
	return []byte(*r.inputs[0].Message)
}
```
Then, throughout the file: `recordingSQS` → `recordingSNS`, `queueURL` → `topicARN`, the
constructor argument `"http://localhost:4566/000000000000/3mrai-local-events"` →
`"arn:aws:sns:us-east-1:000000000000:3mrai-local-events-topic"`, `sqstypes` → `snstypes`,
the `sqs_send_failed` reason assertion → `sns_publish_failed`, and the subtest name
`"publisher_unavailable when the queue url is empty"` →
`"publisher_unavailable when the topic arn is empty"`.

Add one test pinning the transport:
```go
func TestPublishesToTheTopicRatherThanAQueue(t *testing.T) {
	client := &recordingSNS{}
	publisher := sqs.NewPublisher(client, testTopicARN, stubResolver{}, slog.Default())

	publisher.PublishTrackingStatusChanged(context.Background(), sampleStatusChanged())

	if len(client.inputs) != 1 {
		t.Fatalf("published %d messages, want 1", len(client.inputs))
	}
	if got := *client.inputs[0].TopicArn; got != testTopicARN {
		t.Errorf("TopicArn = %q, want %q", got, testTopicARN)
	}
	// CONTRACT: The envelope is preserved byte-for-byte across the transport
	// change — the pipeline's Zod schema validates this exact document.
	var envelope map[string]any
	if err := json.Unmarshal(client.body(t), &envelope); err != nil {
		t.Fatalf("published body is not JSON: %v", err)
	}
	if envelope["type"] != "TRACKING_STATUS_CHANGED" {
		t.Errorf("type = %v, want TRACKING_STATUS_CHANGED", envelope["type"])
	}
	if envelope["source"] != "tracking" {
		t.Errorf("source = %v, want tracking", envelope["source"])
	}
}
```

In `services/tracking-go/cmd/server/main_test.go` line 48, replace
`t.Setenv("EVENTS_QUEUE_URL", "")` with `t.Setenv("EVENTS_TOPIC_ARN", "")`.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make -C services/tracking-go test-no-db
```
Expected: FAIL to build — `no required module provides package
github.com/aws/aws-sdk-go-v2/service/sns`.

- [ ] **Step 3: Add the SNS module**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/services/tracking-go
go get github.com/aws/aws-sdk-go-v2/service/sns
go mod tidy
grep -n 'service/sns\|service/sqs' go.mod
```
Expected: `service/sns` appears in the direct requires. `service/sqs` may drop out once nothing
imports it — `go mod tidy` decides, and that is correct.

- [ ] **Step 4: Swap the transport in the publisher**

In `services/tracking-go/internal/adapter/sqs/publisher.go`, replace the package doc comment's
first line and add the package-name contract:
```go
// Package sqs publishes TRACKING_STATUS_CHANGED onto the shared SNS events topic,
// which fans it out to the pipeline's queue and the notifications queue.
//
// CONTRACT: The package keeps the name `sqs` even though it now publishes to SNS.
// cmd/server/wiring_reachability_test.go pins this import path and asserts the
// composition root still calls NewPublisher, so a rename means editing that
// inventory in the same change.
```
Replace the imports at lines 21-22:
```go
	awssns "github.com/aws/aws-sdk-go-v2/service/sns"
	snstypes "github.com/aws/aws-sdk-go-v2/service/sns/types"
```
Replace the span name (line 38):
```go
const PublishSpanName = "sns.publish tracking_status_changed"
```
Replace the port (lines 47-49):
```go
// PublishAPI is the one SNS call this package makes, declared here by the
// consumer so the SDK client satisfies it directly.
type PublishAPI interface {
	Publish(ctx context.Context, in *awssns.PublishInput, opts ...func(*awssns.Options)) (*awssns.PublishOutput, error)
}
```
Replace the struct and constructor (lines 71-83):
```go
type publisher struct {
	client   PublishAPI
	topicARN string
	resolve  UserResolver
	log      *slog.Logger
}

// NewPublisher builds the SNS-backed publisher.
func NewPublisher(client PublishAPI, topicARN string, resolve UserResolver, log *slog.Logger) Publisher {
	if log == nil {
		log = slog.Default()
	}
	return &publisher{client: client, topicARN: topicARN, resolve: resolve, log: log}
}
```
Replace the guard (line 91) and its comment:
```go
	if p.topicARN == "" || p.client == nil || p.resolve == nil {
		// The publisher could not be obtained or was built without a topic.
		// Publishing to "" would fail once per transition forever on a
		// best-effort path, so the condition is checked where it is observable.
		p.fail(ctx, "publisher_unavailable", in, "")
		return
	}
```
Replace the span attribute (line 123):
```go
			attribute.String("messaging.system", "aws_sns"),
```
Replace the send (lines 131-144):
```go
	_, err = p.client.Publish(ctx, &awssns.PublishInput{
		TopicArn: aws.String(p.topicARN),
		Message:  aws.String(string(body)),
		// The trace context is injected INSIDE this span — see
		// buildMessageAttributes.
		MessageAttributes: buildMessageAttributes(ctx),
	})
	if err != nil {
		// The span going ERROR is the only place this failure is visible in a
		// waterfall: the caller sees nothing, by the policy above.
		span.SetStatus(codes.Error, "sns_publish_failed")
		p.fail(ctx, "sns_publish_failed", in, HashEmail(user.Email))
		return
	}
```
Also change the marshal-failure reason a few lines above from `"sqs_send_failed"` to
`"sns_publish_failed"`.

Replace `buildMessageAttributes`'s signature and value type (lines 274-292), body unchanged:
```go
func buildMessageAttributes(ctx context.Context) map[string]snstypes.MessageAttributeValue {
	attributes := map[string]snstypes.MessageAttributeValue{
		"type":   {DataType: aws.String("String"), StringValue: aws.String(EventType)},
		"source": {DataType: aws.String("String"), StringValue: aws.String(EventSource)},
	}

	carrier := propagation.MapCarrier{}
	otel.GetTextMapPropagator().Inject(ctx, carrier)
	for key, value := range carrier {
		if value == "" {
			continue
		}
		attributes[key] = snstypes.MessageAttributeValue{
			DataType:    aws.String("String"),
			StringValue: aws.String(value),
		}
	}
	return attributes
}
```

- [ ] **Step 5: Rename the config field**

In `services/tracking-go/internal/platform/config/config.go`, replace lines 41-43:
```go
	// EventsTopicARN is the one shared SNS topic all three producers publish to.
	// Defaults to empty; publishing fails (loudly, at the publisher) when it is.
	EventsTopicARN string
```
and line 118:
```go
		EventsTopicARN:         os.Getenv("EVENTS_TOPIC_ARN"),
```

- [ ] **Step 6: Rewire the composition root**

In `services/tracking-go/cmd/server/main.go`, replace the import at line 30:
```go
	awssns "github.com/aws/aws-sdk-go-v2/service/sns"
```
Replace the options block (lines 178-184):
```go
	snsOptions := []func(*awssns.Options){}
	cwOptions := []func(*awscw.Options){}
	if cfg.AWSEndpointURL != nil {
		endpoint := *cfg.AWSEndpointURL
		snsOptions = append(snsOptions, func(o *awssns.Options) { o.BaseEndpoint = &endpoint })
		cwOptions = append(cwOptions, func(o *awscw.Options) { o.BaseEndpoint = &endpoint })
	}
```
Replace the publisher switch (lines 238-261):
```go
	// ── The event publisher ──────────────────────────────────────────────────
	//
	// The noop when EVENTS_TOPIC_ARN is empty, so a runtime with no topic serves
	// every route and emits nothing; publishing to "" would fail once per
	// transition forever on a best-effort path. It resolves the user itself
	// because the pipeline's handler requires an email Tracking never persists.
	publisher := sqs.NewNoopPublisher()
	switch {
	case cfg.EventsTopicARN == "":
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "EVENTS_TOPIC_ARN_empty"))
	case usersClient == nil:
		logger.Warn("events_publishing_disabled",
			slog.String("app_event", "events_publishing_disabled"),
			slog.String("reason", "users_client_unavailable"))
	default:
		publisher = sqs.NewPublisher(
			awssns.NewFromConfig(awsCfg, snsOptions...),
			cfg.EventsTopicARN,
			usersClient,
			logger,
		)
	}
```
Also update the file's header comment at line 9, which names `EVENTS_QUEUE_URL` as one of the
variables read here, to `EVENTS_TOPIC_ARN`.

- [ ] **Step 7: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make -C services/tracking-go test-no-db
```
Expected: PASS. **`zod_contract_test.go` passing unchanged is the key signal** — it reads the
pipeline's Zod schema off disk and compares it against the envelope, so its green is independent
evidence that the wire contract did not drift.

- [ ] **Step 8: Confirm the wiring guard and the full suite**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -rn 'EVENTS_QUEUE_URL\|SendMessage\|sqstypes\|EventsQueueURL' services/tracking-go --include="*.go" || echo "no stale references"
make -C services/tracking-go test-db
```
Expected: `no stale references`, `TestWiringReachability` green (it proves the composition root
still reaches `NewPublisher`), and the full suite green. `test-db` needs the stack up.

- [ ] **Step 9: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
refactor(tracking)!: publish TRACKING_STATUS_CHANGED to SNS instead of SQS

SendMessageAPI -> PublishAPI, EVENTS_QUEUE_URL -> EVENTS_TOPIC_ARN. envelope.go is
untouched — it carries no transport import — so the wire shape is unchanged, which
zod_contract_test.go verifies against the pipeline's own schema. The package keeps
the name `sqs` because wiring_reachability_test.go pins its import path.

BREAKING CHANGE: Tracking now reads EVENTS_TOPIC_ARN; an empty value disables
publishing with an events_publishing_disabled warning, as EVENTS_QUEUE_URL did.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 2.5: Prove the pipeline is unaffected end to end

**Files:** none (a verification task).

**Interfaces:**
- Consumes: all three producers from Tasks 2.1-2.4 and the topology from Phase 1.
- Produces: the evidence that Phase 2 caused no regression. This is the task that justifies the
  whole raw-message-delivery decision, so it is not optional.

- [ ] **Step 1: Rebuild the stack and run the full E2E suite**

The suite already covers every flow the three producers feed: registration → welcome email,
order creation → confirmation email, and the TestMode tracking progression → four status emails
plus four WebSocket pushes.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make env-file
docker compose up -d --build users orders tracking
make test-all
```
Expected: green. **The three specs that matter most here are
`e2e/tests/gateway/realtime-tracking.spec.ts`, `e2e/tests/gateway/orders-flow.spec.ts` and
`e2e/tests/email-templates.spec.ts`** — they exercise the whole chain through the pipeline, so
their passing is what proves the envelope crossed the topic intact.

- [ ] **Step 2: Confirm both queues received the fan-out**

A green suite proves the pipeline's queue works. It does **not** prove the notifications queue got
anything — nothing consumes it until Phase 3, so messages accumulate there and that is exactly
what should be observable.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure/infra/environments/local
NOTIF_URL="$(terraform output -raw notifications_queue_url)"
aws --endpoint-url http://localhost:4566 sqs get-queue-attributes \
  --queue-url "$NOTIF_URL" \
  --attribute-names ApproximateNumberOfMessages
aws --endpoint-url http://localhost:4566 sqs receive-message \
  --queue-url "$NOTIF_URL" --max-number-of-messages 3 \
  --message-attribute-names All \
  --query 'Messages[].{Type:MessageAttributes.type.StringValue,Body:Body}'
```
Expected: a non-zero message count, and every received message's `Type` is `USER_CREATED`,
`ORDER_CREATED` or `TRACKING_STATUS_CHANGED`. **An `AUTH_OTP_REQUESTED` or
`PASSWORD_RESET_REQUESTED` on this queue means the filter policy is not filtering** — recoverable
(Phase 3's consumer discards unknown types anyway) but it must be recorded, because it contradicts
Phase 0's finding.

Each `Body` must be a bare domain envelope starting `{"event_id":"evt_…`. A body containing
`"Type":"Notification"` or a `"Message"` key is the SNS wrapper — raw delivery is off, and the
pipeline's queue is receiving the same wrapper.

- [ ] **Step 3: Confirm the traceparent still joins the trace across the topic**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
open http://localhost:5080
```
In OpenObserve, find a recent `sns.publish user_created` span and confirm the pipeline's
`process_record` hangs **beneath** it rather than beside it. If the trace waterfall answers HTTP
400 (`code 20004`, `gen_ai_operation_name`), run `make observability-traces-schema` and retry —
that is a known ingest-schema gap, not a tracing bug.

Expected: one connected trace per event. A pipeline span rooted separately means the `traceparent`
message attribute did not survive, which under raw delivery it should.

- [ ] **Step 4: Report the results (no commit)**

Nothing to commit — this task changes no files. Report to the user: the E2E result, the
notifications-queue depth and the types observed on it, and whether tracing stayed joined.

### 🚦 GATE 2 — STOP HERE (dependency gate)

Phase 3's consumer cannot receive anything real until Phase 2 has landed and the notifications
queue is actually being fed. **Batch Tasks 2.1-2.5 as one list of open PRs for the user to review
and merge, then stop.** Continue to Phase 3 only after they are merged.

---

## Phase 3 — Users backend: schema, copy map, consumer, push, endpoints

**Precondition: GATE 2 passed** (all three producers publish to the topic; the notifications queue
is being fed).

### Task 3.1: Add the `Notification` model and its migration

**Files:**
- Modify: `services/users/prisma/schema.prisma` (append after `UsersCognitoEvent`)
- Create: `services/users/prisma/migrations/20260910000000_add_notifications/migration.sql`
- Modify: `services/users/src/shared/id/nano-id.ts` (`PREFIXES`, the factory, `MODEL_ID_PREFIXES`)
- Modify: `services/users/src/shared/db/prisma-extensions.ts` (`RESULT_EXTENSIONS`)
- Test: `services/users/tests/shared/nano-id.test.ts`

**Interfaces:**
- Consumes: the audit-field shape used by `User` / `UsersCognitoData` / `UsersCognitoEvent`, and
  the `crossCuttingExtension` that auto-stamps `id` from `MODEL_ID_PREFIXES` and
  `createdBy`/`updatedBy` from the AsyncLocalStorage actor.
- Produces:
  - Prisma model `Notification` → table `notifications`, and `db.notification` on the client
    (`Db["notification"]`), with fields `id`, `userId`, `type`, `title`, `body`, `metadata`,
    `readAt`, plus the six audit columns and the `isDeleted` computed field.
  - `NanoIdConfig.newNotificationId(): string` returning `ntf_` + 24 chars.
  - `MODEL_ID_PREFIXES.Notification = "ntf_"`, so the extension stamps ids automatically.
  - `RESULT_EXTENSIONS.notification`, so `row.isDeleted` exists.
  - Tasks 3.4-3.7 all read and write through `db.notification`.

- [ ] **Step 1: Write the failing test**

Append to `services/users/tests/shared/nano-id.test.ts`:
```ts
describe("notification ids", () => {
  it("mints an ntf_-prefixed id of the shared width", () => {
    const id = NanoIdConfig.newNotificationId();
    expect(id).toMatch(NanoIdConfig.pattern("ntf_"));
    expect(id).toHaveLength(NanoIdConfig.TOTAL_LENGTH);
  });

  // CONTRACT: The Prisma extension looks a model up by NAME in MODEL_ID_PREFIXES
  // to stamp `id`. A missing entry logs a warning and inserts a row with no id,
  // which fails on the primary key — at runtime, not at compile time.
  it("registers the model prefix so the extension can stamp it", () => {
    expect(MODEL_ID_PREFIXES.Notification).toBe("ntf_");
  });
});
```
Ensure the file imports `MODEL_ID_PREFIXES` alongside `NanoIdConfig`.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- nano-id
```
Expected: FAIL — `NanoIdConfig.newNotificationId is not a function`.

- [ ] **Step 3: Add the model to the Prisma schema**

Append to `services/users/prisma/schema.prisma`:
```prisma
// One in-app notification, rendered at write time.
//
// CONTRACT: `title`/`body` store RENDERED COPY, deliberately. Copy therefore lives
// in two places — the pipeline's email templates and this service's copy map — and
// a copy change leaves stored rows with the old text. That is the intended
// reading: rendered copy is a historical fact, like a sent email.
// `metadata` is what keeps presentation DERIVED rather than baked into the text:
// without `status`/`order_id` the web could only print the string, with no icon,
// no tint and no "View order" CTA.
// See [[2026-09-10-in-app-notifications-design]]
model Notification {
  id String @id
  // CONTRACT: No foreign key to User.id, unlike the sibling tables. A
  // TRACKING_STATUS_CHANGED can arrive for a user row that does not exist yet or
  // is soft-deleted, and an FK would turn that into an insert failure retried to
  // the DLQ. The row is stored; the GET filters by the authenticated user and
  // simply never serves it.
  userId String @map("user_id")
  // "WELCOME" | "ORDER_STATUS". A column, not a `metadata` key: it drives the
  // toast eyebrow and the CTA and is needed on every row — structure, not detail.
  // Deliberately a plain String, not an enum, so a new variant needs no migration.
  type  String
  title String
  body  String
  // { status?, order_id?, order_number?, occurred_at }
  // CONTRACT: `occurred_at` lives here and is therefore NOT indexable. Acceptable
  // because ordering is by `createdAt` and the list caps at 50. Ordering by
  // `occurred_at` would require promoting it to a column.
  metadata Json
  // A timestamp, not an isRead boolean — the same shape as deletedAt, and it
  // answers "when" as well as "whether".
  readAt DateTime? @map("read_at") @db.Timestamptz(6)

  // CONTRACT: `createdBy` is NON-NULLABLE here, unlike the sibling tables. The
  // consumer runs OUTSIDE any request, so the AsyncLocalStorage actor the
  // cross-cutting extension reads is undefined and would stamp null — the
  // consumer passes the actor explicitly instead.
  // See [[audit-fields]]
  createdBy String    @map("created_by")
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy String?   @map("updated_by")
  updatedAt DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedBy String?   @map("deleted_by")
  deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)

  @@map("notifications")
  // Serves both the filtered list and the unread count: every query is scoped to
  // one user and then split on read/unread.
  @@index([userId, readAt])
  @@index([deletedAt])
}
```

- [ ] **Step 4: Register the prefix and the computed field**

In `services/users/src/shared/id/nano-id.ts`, add to `PREFIXES` (in the Prisma-models group):
```ts
  Notification: "ntf_",
```
add the factory beside the others:
```ts
  newNotificationId: () => mint(PREFIXES.Notification),
```
and add to `MODEL_ID_PREFIXES`:
```ts
  Notification: PREFIXES.Notification,
```

In `services/users/src/shared/db/prisma-extensions.ts`, add to `RESULT_EXTENSIONS`:
```ts
  notification: isDeletedField,
```

- [ ] **Step 5: Generate the client and write the migration**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users exec prisma generate
mkdir -p services/users/prisma/migrations/20260910000000_add_notifications
```

Create `services/users/prisma/migrations/20260910000000_add_notifications/migration.sql`:
```sql
-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "read_at" TIMESTAMPTZ(6),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_by" TEXT,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_deleted_at_idx" ON "notifications"("deleted_at");
```

- [ ] **Step 6: Run the test and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- nano-id && pnpm --filter users test -- prisma-extensions
```
Expected: PASS. The extensions test asserts the schema and `RESULT_EXTENSIONS` agree, so it fails
if the model was added without its `isDeleted` entry.

- [ ] **Step 7: Apply the migration and confirm the table matches the schema**

**A migration version table lies about the schema** — Prisma consults `_prisma_migrations`, not
the tables — so check the columns, not just the exit code.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make migrate
pgport="$(.venv/bin/python infra/scripts/discover_db_port.py postgres)"
docker run --rm --network 3mrai_3mrai-network -e PGPASSWORD=test postgres:16-alpine \
  psql -h floci -p "$pgport" -U test -d users -c '\d notifications'
```
Expected: `Prisma migrations applied.`, then a table listing all 13 columns with `read_at`,
`created_at`, `updated_at` and `deleted_at` as `timestamp with time zone`, plus both indexes.
An empty result while `make migrate` reported success is the version-table trap — see
[[2026-09-09-migration-version-tables-lie-about-schema]].

- [ ] **Step 8: Confirm the write user can INSERT but not DELETE**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
pgport="$(.venv/bin/python infra/scripts/discover_db_port.py postgres)"
docker run --rm --network 3mrai_3mrai-network -e PGPASSWORD=test postgres:16-alpine \
  psql -h floci -p "$pgport" -U test -d users -c \
  "SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name='notifications' AND grantee='users_app' ORDER BY privilege_type;"
```
Expected: `INSERT`, `SELECT`, `UPDATE` — and **no `DELETE`**. That absence is
[[ADR-0004-soft-delete-only]] enforced at the infrastructure level, and it is why decision 9's
"no retention job" is not merely a preference. An empty result means the post-apply
`ALTER DEFAULT PRIVILEGES` did not cover this table — run `make post-infra`.

- [ ] **Step 9: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): add the Notification model and its migration

Rendered title/body plus a metadata JSON, six audit columns, and no foreign key to
users — a status event can arrive for a user row that does not exist yet, and an FK
would DLQ it. No idempotency key, by decision: a duplicate on SQS redelivery is an
accepted outcome.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 3.2: Build the copy map — the eleven variants

**Files:**
- Create: `services/users/src/features/notifications/domain/notification-copy.ts`
- Test: `services/users/tests/features/notifications/notification-copy.test.ts`

**Interfaces:**
- Consumes: nothing (a pure module, deliberately — it is the single source of rendered copy).
- Produces:
  - `export type NotificationType = "WELCOME" | "ORDER_STATUS"`
  - `export type TrackingStatus = "PLACED" | "PROCESSING" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED"`
    — the **stored** `metadata.status` domain, five wide. `PLACED` is written by the
    `ORDER_CREATED` path.
  - `export type TrackingEventStatus = Exclude<TrackingStatus, "PLACED">` — what a
    `TRACKING_STATUS_CHANGED` **event** can carry, four wide. `PLACED` is the status a tracking row
    is created in, never a transition, so no event ever carries it. **These two types are
    deliberately distinct**: collapsing them lets a tracking-event parser accept a status that
    cannot exist, which is the bug the spec's correction is about.
  - `export interface NotificationCopy { title: string; body: string }`
  - `export interface TrackingCopyInput { status: TrackingEventStatus; orderNumberFormatted?: string; changedAt: string }`
  - `export interface PlacedCopyInput { orderNumberFormatted?: string }`
  - `export function welcomeCopy(): NotificationCopy`
  - `export function placedCopy(input: PlacedCopyInput): NotificationCopy` — the `PLACED` variant,
    triggered by `ORDER_CREATED`.
  - `export function trackingCopy(input: TrackingCopyInput): NotificationCopy`
  - `export const TRACKING_TITLES: Readonly<Record<TrackingStatus, string>>` — all five titles
    (`PLACED` included, since the stored domain is five wide), exported so Task 3.3's parity test
    can compare the **four transition** titles against the four
    `tracking-status-changed-*` templates.
  - `export const TRACKING_EVENT_STATUSES: readonly TrackingEventStatus[]` — the four, exported so
    Task 3.5's event parser rejects `PLACED` rather than re-listing them.
  - Task 3.5's `CreateNotificationCommand` calls all three copy functions.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/notifications/notification-copy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  TRACKING_EVENT_STATUSES,
  TRACKING_TITLES,
  placedCopy,
  trackingCopy,
  welcomeCopy,
  type TrackingEventStatus,
} from "#features/notifications/domain/notification-copy";

const ORDER_NUMBER = "ORD-3MRAI-10482";
// The instant the .pen's DELIVERED body quotes: "Delivered Aug 5, 3:31 pm."
const CHANGED_AT = "2026-08-05T15:31:55";

describe("welcomeCopy", () => {
  it("renders the WELCOME variant verbatim", () => {
    expect(welcomeCopy()).toEqual({
      title: "Welcome to 3MRAI!",
      body: "Your account is ready. Start exploring orders, tracking and more.",
    });
  });
});

// CONTRACT: PLACED is triggered by ORDER_CREATED, NOT by a tracking status
// transition — Tracking never emits PLACED. Its copy therefore has its own entry
// point, taking no timestamp because its body quotes none.
describe("placedCopy", () => {
  it("renders the PLACED variant with the order number prefix", () => {
    expect(placedCopy({ orderNumberFormatted: ORDER_NUMBER })).toEqual({
      title: "Order placed",
      body: `${ORDER_NUMBER} · Received and confirmed. We'll email your receipt.`,
    });
  });

  it("tolerates an absent order number", () => {
    const { title, body } = placedCopy({});
    expect(title).toBe("Order placed");
    expect(body).toBe("Received and confirmed. We'll email your receipt.");
    expect(body).not.toContain("undefined");
  });
});

describe("trackingCopy", () => {
  // The two static bodies, verbatim from the .pen's status-variants sheet.
  it.each([
    ["PROCESSING", "Your order is being prepared", "Being picked and packed for shipment."],
    ["SHIPPED", "Your order has shipped", "Handed to the carrier and on its way to you."],
  ] as const)("renders %s with the order number prefix", (status, title, tail) => {
    expect(trackingCopy({ status, orderNumberFormatted: ORDER_NUMBER, changedAt: CHANGED_AT }))
      .toEqual({ title, body: `${ORDER_NUMBER} · ${tail}` });
  });

  // CONTRACT: These two COMPOSE their body from the payload's timestamp rather
  // than using a static string — the .pen bodies quote a date/time.
  it("composes the OUT_FOR_DELIVERY body from the payload timestamp", () => {
    expect(
      trackingCopy({
        status: "OUT_FOR_DELIVERY",
        orderNumberFormatted: ORDER_NUMBER,
        changedAt: CHANGED_AT,
      }),
    ).toEqual({
      title: "Out for delivery",
      body: `${ORDER_NUMBER} · Arriving today, by 6:00 pm.`,
    });
  });

  it("composes the DELIVERED body from the payload timestamp", () => {
    expect(
      trackingCopy({
        status: "DELIVERED",
        orderNumberFormatted: ORDER_NUMBER,
        changedAt: CHANGED_AT,
      }),
    ).toEqual({
      title: "Delivered",
      body: `${ORDER_NUMBER} · Delivered Aug 5, 3:31 pm.`,
    });
  });

  // CONTRACT: `order_number.formatted` is OMITTED when the order has none (an
  // order predating the backfill), so the body must degrade to the bare sentence
  // rather than rendering "undefined · ".
  it.each([
    "PROCESSING",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
  ] as const)("tolerates an absent order number for %s", (status) => {
    const { title, body } = trackingCopy({ status, changedAt: CHANGED_AT });
    expect(title).toBe(TRACKING_TITLES[status]);
    expect(body).not.toContain("undefined");
    expect(body).not.toMatch(/^\s*·/);
  });

  // The STORED domain is five wide (PLACED included, written by the ORDER_CREATED
  // path); the EVENT domain is the four transitions. Asserting both here is what
  // stops a later edit from quietly folding PLACED back into the event list.
  it("exposes all five stored titles", () => {
    expect(Object.keys(TRACKING_TITLES).sort()).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
    );
  });

  it("exposes exactly the four event statuses, PLACED excluded", () => {
    const expected: TrackingEventStatus[] = [
      "PROCESSING",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
    ];
    expect([...TRACKING_EVENT_STATUSES].sort()).toEqual([...expected].sort());
    expect(TRACKING_EVENT_STATUSES).not.toContain("PLACED");
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- notification-copy
```
Expected: FAIL — `Cannot find module '#features/notifications/domain/notification-copy'`.

- [ ] **Step 3: Write the copy map**

Create `services/users/src/features/notifications/domain/notification-copy.ts`:
```ts
// CONTRACT: This module is the SINGLE source of rendered notification copy, and it
// is deliberately pure — no db, no logger, no clock. Copy also exists in the
// pipeline's email templates (functions/events-pipeline/emails/), which is the
// accepted consequence of storing rendered text: a copy change here does not
// rewrite rows already stored, exactly as a sent email is not rewritten.
// The FOUR transition titles MATCH tracking-status-changed.tsx's headings; a test
// pins that. "Order placed" is independent — its trigger is ORDER_CREATED, whose
// email is the order-created template ("Order confirmed").
// See [[2026-09-10-in-app-notifications-design]]

/** Drives the toast eyebrow and the CTA. Stored as a column, not in metadata. */
export type NotificationType = "WELCOME" | "ORDER_STATUS";

/**
 * The STORED `metadata.status` domain, five wide. `PLACED` belongs here because a
 * placed notification persists identically to the four tracking-driven ones — only
 * its trigger differs.
 */
export type TrackingStatus =
  | "PLACED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

/**
 * What a TRACKING_STATUS_CHANGED EVENT can carry, four wide.
 *
 * CONTRACT: `PLACED` is EXCLUDED and must stay excluded. It is the status a
 * tracking row is created in, never a transition, and Tracking's publisher fires
 * only from the transition path — so no event ever carries it. The PLACED
 * notification is triggered by ORDER_CREATED instead.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export type TrackingEventStatus = Exclude<TrackingStatus, "PLACED">;

/** The four, as a value, so a parser narrows without re-listing them. */
export const TRACKING_EVENT_STATUSES: readonly TrackingEventStatus[] = [
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export interface NotificationCopy {
  title: string;
  body: string;
}

export interface TrackingCopyInput {
  status: TrackingEventStatus;
  /**
   * The display form from the tracking payload's `order_number.formatted`.
   * CONTRACT: OPTIONAL. The producer omits the key entirely for an order
   * predating the backfill, so an absent value must degrade to the bare
   * sentence rather than rendering a stray separator.
   */
  orderNumberFormatted?: string;
  /** The transition's own timestamp, which two bodies quote. */
  changedAt: string;
}

/** The PLACED variant's input. No timestamp: its body quotes none. */
export interface PlacedCopyInput {
  /** `order_number.formatted` from ORDER_CREATED's payload, absent for an order with none. */
  orderNumberFormatted?: string;
}

/**
 * All five stored titles. The FOUR transition titles match the `COPY` headings in
 * functions/events-pipeline/emails/tracking-status-changed.tsx; "Order placed" is
 * an in-app string with no tracking-template counterpart, since its trigger is
 * ORDER_CREATED. Task 3.3's parity test pins the four and documents the one.
 */
export const TRACKING_TITLES: Readonly<Record<TrackingStatus, string>> = {
  PLACED: "Order placed",
  PROCESSING: "Your order is being prepared",
  SHIPPED: "Your order has shipped",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
};

/** The two transition bodies that need no value from the payload. */
const STATIC_BODIES: Readonly<Record<"PROCESSING" | "SHIPPED", string>> = {
  PROCESSING: "Being picked and packed for shipment.",
  SHIPPED: "Handed to the carrier and on its way to you.",
};

/** The PLACED body, verbatim from the .pen. */
const PLACED_BODY = "Received and confirmed. We'll email your receipt.";

/** The delivery window the OUT_FOR_DELIVERY body promises. */
const DELIVERY_CUTOFF = "6:00 pm";

/**
 * `Aug 5, 3:31 pm` — the form the DELIVERED body quotes. Month and day without a
 * year, matching the notification frames rather than the order timeline's fuller
 * `Aug 2, 2026 · 10:24 am`.
 *
 * CONTRACT: Formats in UTC. The producer sends a zone-less local timestamp
 * (`2006-01-02T15:04:05`), so letting the server's zone interpret it would render
 * a different clock time per deployment for the same stored instant.
 */
function formatStamp(changedAt: string): string {
  // The producer's zone-less form needs an explicit Z, or JS reads it as local.
  const normalized = /(Z|[+-]\d{2}:?\d{2})$/.test(changedAt) ? changedAt : `${changedAt}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return changedAt;

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    // Intl renders "PM"; the frames render "pm".
    .replace(/\b(AM|PM)\b/, (match) => match.toLowerCase())
    // Intl separates date and time with ", " — the frames keep that.
    .replace(/ /g, " ");
}

/** Prefixes the order number when there is one, and nothing when there is not. */
function withOrderNumber(sentence: string, orderNumberFormatted?: string): string {
  return orderNumberFormatted ? `${orderNumberFormatted} · ${sentence}` : sentence;
}

/** The WELCOME variant. Takes nothing: its copy quotes no value. */
export function welcomeCopy(): NotificationCopy {
  return {
    title: "Welcome to 3MRAI!",
    body: "Your account is ready. Start exploring orders, tracking and more.",
  };
}

/**
 * The PLACED ORDER_STATUS variant.
 *
 * CONTRACT: Triggered by ORDER_CREATED, NOT by a tracking status. Do NOT route it
 * through trackingCopy — no TRACKING_STATUS_CHANGED ever carries PLACED, and a
 * shared entry point invites a parser that accepts one.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export function placedCopy(input: PlacedCopyInput): NotificationCopy {
  return {
    title: TRACKING_TITLES.PLACED,
    body: withOrderNumber(PLACED_BODY, input.orderNumberFormatted),
  };
}

/** One of the four transition ORDER_STATUS variants. */
export function trackingCopy(input: TrackingCopyInput): NotificationCopy {
  const { status, orderNumberFormatted, changedAt } = input;
  const title = TRACKING_TITLES[status];

  if (status === "OUT_FOR_DELIVERY") {
    return {
      title,
      body: withOrderNumber(`Arriving today, by ${DELIVERY_CUTOFF}.`, orderNumberFormatted),
    };
  }

  if (status === "DELIVERED") {
    return {
      title,
      body: withOrderNumber(`Delivered ${formatStamp(changedAt)}.`, orderNumberFormatted),
    };
  }

  return { title, body: withOrderNumber(STATIC_BODIES[status], orderNumberFormatted) };
}
```

- [ ] **Step 4: Run the test and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- notification-copy
```
Expected: PASS, 13 tests. A failure on the DELIVERED body is almost always the timestamp format —
compare the received string against `Aug 5, 3:31 pm` character by character (`Intl` emits a
narrow no-break space before the meridiem, which the ` ` replacement normalizes).

- [ ] **Step 5: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): add the notification copy map for the eleven variants

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.3: Pin title parity with the email templates (the four transitions)

**Files:**
- Test: `services/users/tests/features/notifications/notification-copy.test.ts` (append)

**Interfaces:**
- Consumes: `TRACKING_TITLES` and `TRACKING_EVENT_STATUSES` from Task 3.2 (both already imported
  at the top of this test file by Task 3.2's step 1 — this task appends a `describe` block, it does
  not add imports beyond `node:fs` and `node:url`), and the pipeline's
  `functions/events-pipeline/emails/tracking-status-changed.tsx` `COPY` map read **off disk**.
- Produces: no runtime code — a regression guard over the **four transition** titles. `PLACED` is
  asserted to be intentionally unpinned, with the reason recorded in the test.

The spec records the frame's claim that "Titles match the email headings in
tracking-status-changed" as a **plan-time verification, not an assumption**. That verification was
performed while writing this plan and **it holds**: the pipeline's `COPY` headings are `Order
placed`, `Your order is being prepared`, `Your order has shipped`, `Out for delivery`, `Delivered`
— identical to `TRACKING_TITLES`. So this task's job is not to discover the answer but to stop the
two drifting apart silently.

**What parity can and cannot be asserted, given the spec's correction.** The four **transition**
titles pin against the four `tracking-status-changed-*` templates, because for each of those a
single tracking event produces both the email and the notification — one event, one sentence, two
channels, and a change to one without the other tells one user two stories. `PLACED` is different:
its trigger is `ORDER_CREATED`, whose email is the **`order-created`** template with subject
**"Order confirmed"** — a receipt, not a status heading. The `tracking-status-changed-placed`
template exists but is **never rendered**, because `PLACED` is never emitted as a tracking status
(see Concerns §1), so pinning "Order placed" to it would pin a live string to dead copy.

**The assertion this task therefore writes: four tracking titles pinned to their four templates,
and `PLACED`'s title asserted to be intentionally independent** — present in `TRACKING_TITLES`,
deliberately absent from the pinned set, with the reason in a comment. Asserting five-way parity
would be asserting something the code is not required to satisfy: a future copy change to
"Order confirmed"'s email heading would fail a test for no reason a reader could act on.

- [ ] **Step 1: Write the parity test**

Reading the sibling package's source off disk is the established pattern here — Tracking's
`zod_contract_test.go` does exactly this against the same pipeline directory.

Append to `services/users/tests/features/notifications/notification-copy.test.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("email template parity", () => {
  // CONTRACT: Read the pipeline's source off disk rather than importing it. The
  // two packages have separate dependency trees and this must not couple them at
  // build time — the same approach Tracking's zod_contract_test.go takes against
  // this very directory.
  const TEMPLATE_PATH = fileURLToPath(
    new URL(
      "../../../../../functions/events-pipeline/emails/tracking-status-changed.tsx",
      import.meta.url,
    ),
  );

  /** Pulls `STATUS: { heading: "…" }` pairs out of the template's COPY map. */
  function emailHeadings(): Record<string, string> {
    const source = readFileSync(TEMPLATE_PATH, "utf8");
    const headings: Record<string, string> = {};
    const pattern = /(\w+):\s*\{\s*\n?\s*heading:\s*"([^"]+)"/g;
    for (const match of source.matchAll(pattern)) {
      headings[match[1]!] = match[2]!;
    }
    return headings;
  }

  it("finds the five headings in the template", () => {
    // Guards the regex itself: a template refactor that breaks the match would
    // otherwise make the parity assertion below vacuously pass. The template still
    // declares five, PLACED included — it is provisioned but never rendered.
    const headings = emailHeadings();
    expect(Object.keys(headings).sort()).toEqual(
      ["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"].sort(),
    );
  });

  // CONTRACT: Parity is pinned for the FOUR transition statuses only. For each of
  // those one TRACKING_STATUS_CHANGED produces both the email and the
  // notification, so the two must read the same sentence.
  it("matches every transition title to its email heading", () => {
    const headings = emailHeadings();
    for (const status of TRACKING_EVENT_STATUSES) {
      expect(headings[status]).toBe(TRACKING_TITLES[status]);
    }
  });

  // CONTRACT: "Order placed" is an IN-APP string with no tracking-template
  // counterpart. Its trigger is ORDER_CREATED, whose email is the `order-created`
  // template with subject "Order confirmed"; the tracking-status-changed-placed
  // template is never rendered, because PLACED is never emitted as a tracking
  // status. Do NOT extend the loop above to cover it — that would pin a live
  // string to dead copy. See [[2026-09-10-in-app-notifications-design]]
  it("leaves the PLACED title intentionally unpinned", () => {
    expect(TRACKING_TITLES.PLACED).toBe("Order placed");
    expect(TRACKING_EVENT_STATUSES).not.toContain("PLACED");
  });
});
```

- [ ] **Step 2: Run it and see it pass immediately**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- notification-copy
```
Expected: PASS, 16 tests. **This test passing on first run is the expected outcome**, not a sign
the test is weak — parity already holds, and Step 3 proves the test can actually fail.

- [ ] **Step 3: Prove the guard bites**

A parity test that cannot fail is decoration. Temporarily change `TRACKING_TITLES.DELIVERED` in
`notification-copy.ts` to `"Delivered!"` and re-run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- notification-copy
```
Expected: FAIL, naming `DELIVERED` with `"Delivered!"` versus `"Delivered"`. **Revert the change**
and re-run to confirm green.

- [ ] **Step 4: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
test(users): pin the four transition titles to the email template headings

The frame asserts the two match; verified at plan time that they do. This guard
stops them drifting apart silently, reading the pipeline's source off disk the way
Tracking's zod contract test already does. PLACED is deliberately unpinned: its
trigger is ORDER_CREATED, whose email is the order-created template, and the
tracking-status-changed-placed template is never rendered.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.4: Add the WebSocket push (Users' own copy of the fan-out)

**Files:**
- Create: `services/users/src/shared/realtime/connections-reader.ts`
- Create: `services/users/src/shared/realtime/websocket-publisher.ts`
- Modify: `services/users/package.json` (three SDK dependencies)
- Test: `services/users/tests/shared/realtime/websocket-publisher.test.ts`

**Interfaces:**
- Consumes: `env.WS_MANAGEMENT_ENDPOINT`, `env.WS_CONNECTIONS_TABLE`, `env.WS_CONNECTIONS_GSI`,
  `env.AWS_REGION`, `env.AWS_ENDPOINT_URL` (Task 2.2); `appLogger`.
- Produces:
  - `connections-reader.ts`: `queryByCognitoSub(cognitoSub: string): Promise<string[]>` and
    `deleteConnection(connectionId: string): Promise<void>` — **both THROW**, by contract.
  - `websocket-publisher.ts`: `publishToUser(cognitoSub: string, message: unknown): Promise<void>`
    — **NEVER throws**, and `export interface NotificationCreatedMessage` describing the frame.
  - Task 3.5's `CreateNotificationCommand` calls `publishToUser` after the insert commits.

This mirrors `functions/events-pipeline/src/shared/realtime/websocket-publisher.ts` rather than
importing it: the two packages have separate dependency trees and separate deploy units, and the
pipeline's copy reads its config from bare `process.env` while Users has a validated `env` object.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/shared/realtime/websocket-publisher.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked at the module boundary: the reader's own contract is that it throws, and
// this suite exists to prove the publisher SWALLOWS those throws.
const queryByCognitoSub = vi.fn<(sub: string) => Promise<string[]>>();
const deleteConnection = vi.fn<(id: string) => Promise<void>>();
const send = vi.fn();

vi.mock("#shared/realtime/connections-reader", () => ({
  queryByCognitoSub: (sub: string) => queryByCognitoSub(sub),
  deleteConnection: (id: string) => deleteConnection(id),
}));

vi.mock("@aws-sdk/client-apigatewaymanagementapi", () => ({
  ApiGatewayManagementApiClient: class {
    send = send;
  },
  PostToConnectionCommand: class {
    constructor(public readonly input: unknown) {}
  },
}));

const { publishToUser } = await import("#shared/realtime/websocket-publisher");

describe("publishToUser", () => {
  beforeEach(() => {
    queryByCognitoSub.mockReset();
    deleteConnection.mockReset();
    send.mockReset();
    send.mockResolvedValue({});
  });

  it("pushes to every open socket the user has", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1", "conn-2"]);

    await publishToUser("sub-abc", { type: "NOTIFICATION_CREATED" });

    expect(queryByCognitoSub).toHaveBeenCalledWith("sub-abc");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when the user has nothing open", async () => {
    queryByCognitoSub.mockResolvedValue([]);

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  // The reactive cleanup the design leans on — the TTL is only a backstop.
  it("deletes a connection that answers 410 Gone", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue(
      Object.assign(new Error("gone"), { name: "GoneException" }),
    );

    await publishToUser("sub-abc", {});

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
  });

  it("also treats a bare 410 status as gone", async () => {
    queryByCognitoSub.mockResolvedValue(["dead-conn"]);
    send.mockRejectedValue({ $metadata: { httpStatusCode: 410 } });

    await publishToUser("sub-abc", {});

    expect(deleteConnection).toHaveBeenCalledWith("dead-conn");
  });

  // CONTRACT: The push must never fail the persistence. The notification is
  // already stored and appears when the panel is opened; realtime is an
  // enhancement, never the source of truth.
  it("never throws when a push fails", async () => {
    queryByCognitoSub.mockResolvedValue(["conn-1"]);
    send.mockRejectedValue(new Error("management api down"));

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
  });

  it("never throws when the connections lookup itself fails", async () => {
    queryByCognitoSub.mockRejectedValue(new Error("dynamodb unreachable"));

    await expect(publishToUser("sub-abc", {})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- websocket-publisher
```
Expected: FAIL — `Cannot find module '#shared/realtime/websocket-publisher'`.

- [ ] **Step 3: Install the three SDK clients**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users add @aws-sdk/client-apigatewaymanagementapi @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
```
Expected: three packages added to `services/users/package.json`.

- [ ] **Step 4: Write the connections reader**

Create `services/users/src/shared/realtime/connections-reader.ts`:
```ts
// CONTRACT: Every function here THROWS. Reach this module only through
// `publishToUser`, which is where the never-fail-the-persistence guarantee lives.
// Calling either function straight from a command puts an uncaught throw on the
// notification write path, and the row is then lost for a socket problem.
// See [[2026-09-10-in-app-notifications-design]]
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { env } from "#shared/config/env";

let docClient: DynamoDBDocumentClient | null = null;

// Built lazily so importing this module opens no connection — the unit suite
// imports it transitively and must not reach a real endpoint.
function client(): DynamoDBDocumentClient {
  if (docClient === null) {
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: env.AWS_REGION, endpoint: env.AWS_ENDPOINT_URL }),
    );
  }
  return docClient;
}

/**
 * Every open connection for one user.
 *
 * CONTRACT: The argument MUST be a Cognito `sub`, never the internal `usr_` id.
 * The GSI is keyed by `cognito_sub`, so querying it with a `usr_` id returns an
 * empty list and NO error — which reads exactly like "the user has nothing open".
 * See [[user-id-vs-cognito-sub-ownership-key]]
 */
export async function queryByCognitoSub(cognitoSub: string): Promise<string[]> {
  const result = await client().send(
    new QueryCommand({
      TableName: env.WS_CONNECTIONS_TABLE,
      IndexName: env.WS_CONNECTIONS_GSI,
      KeyConditionExpression: "cognito_sub = :s",
      ExpressionAttributeValues: { ":s": cognitoSub },
      ProjectionExpression: "connection_id",
    }),
  );
  return (result.Items ?? []).map((item) => String(item.connection_id));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client().send(
    new DeleteCommand({
      TableName: env.WS_CONNECTIONS_TABLE,
      Key: { connection_id: connectionId },
    }),
  );
}
```

- [ ] **Step 5: Write the publisher**

Create `services/users/src/shared/realtime/websocket-publisher.ts`:
```ts
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { SpanKind, trace } from "@opentelemetry/api";
import { env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { queryByCognitoSub, deleteConnection } from "#shared/realtime/connections-reader";
import { withClientSpan } from "#shared/observability/client-span";

/**
 * The frame the web app receives. `unread_count` rides along so the badge updates
 * without a second request.
 */
export interface NotificationCreatedMessage {
  type: "NOTIFICATION_CREATED";
  notification: {
    id: string;
    type: string;
    title: string;
    body: string;
    metadata: unknown;
    read_at: string | null;
  };
  unread_count: number;
}

let apiClient: ApiGatewayManagementApiClient | null = null;

function client(): ApiGatewayManagementApiClient {
  if (apiClient === null) {
    // WORKAROUND(local): Floci's @connections endpoint carries an undocumented
    // /execute-api/{apiId}/{stage} prefix, unlike real AWS. Generated into the env
    // file, never derived. A wrong endpoint answers HTTP 400 with an S3 XML body,
    // which looks nothing like an endpoint problem.
    // See [[floci-websocket-works]]
    apiClient = new ApiGatewayManagementApiClient({
      region: env.AWS_REGION,
      endpoint: env.WS_MANAGEMENT_ENDPOINT,
    });
  }
  return apiClient;
}

function isGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "GoneException" || e.$metadata?.httpStatusCode === 410;
}

/**
 * Fan a message out to every socket the user has open. NEVER throws.
 *
 * CONTRACT: The push must never fail the persistence. The row is already
 * committed and appears when the panel is opened, so raising here would lose a
 * stored notification over a socket problem — and on SQS redelivery would store
 * it twice. Realtime is an enhancement, never the source of truth.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export async function publishToUser(cognitoSub: string, message: unknown): Promise<void> {
  // Manual PRODUCER span, as the pipeline's publisher has: `describeError` is
  // required because this function never throws, so the outcome rides on the
  // attributes rather than the span status.
  return withClientSpan(
    "ws publish",
    SpanKind.PRODUCER,
    { "messaging.system": "apigatewaymanagementapi", "messaging.operation": "publish" },
    () => fanOut(cognitoSub, message),
    (error) => (error instanceof Error ? error.message : "unknown"),
  );
}

async function fanOut(cognitoSub: string, message: unknown): Promise<void> {
  const span = trace.getActiveSpan();
  try {
    const connectionIds = await queryByCognitoSub(cognitoSub);
    // Recorded even when zero, and BEFORE the early return: "the user had nothing
    // open" and "the fan-out never got that far" are different stories, and a
    // missing attribute cannot tell them apart.
    span?.setAttribute("messaging.batch.message_count", connectionIds.length);
    if (connectionIds.length === 0) return;

    const data = Buffer.from(JSON.stringify(message));

    await Promise.all(
      connectionIds.map(async (connectionId) => {
        try {
          await client().send(
            new PostToConnectionCommand({ ConnectionId: connectionId, Data: data }),
          );
        } catch (error) {
          if (isGone(error)) {
            // The reactive cleanup the design leans on — the TTL is only a
            // backstop. A dead connection is expected, not a failure.
            await deleteConnection(connectionId).catch(() => undefined);
            return;
          }
          appLogger.error({
            app_event: "notification_push_failed",
            connection_id: connectionId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      }),
    );
  } catch (error) {
    appLogger.error({
      app_event: "notification_push_failed",
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}
```

- [ ] **Step 6: Add the client-span helper Users lacks**

Users has `withPublishSpan` and `withWorkflowSpan` but no CLIENT/PRODUCER wrapper.

Create `services/users/src/shared/observability/client-span.ts`:
```ts
import { SpanKind, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

const tracer = trace.getTracer("users-realtime");

/**
 * Run `fn` inside a CLIENT or PRODUCER span for one outbound call.
 *
 * CONTRACT: Keep `span.end()` in a `finally` — a span left open on the exception
 * path is never exported and vanishes from the waterfall without erroring
 * anywhere. Parentage comes from the ambient context, which is why nothing takes a
 * parent argument. See [[logging-context]]
 */
export function withClientSpan<T>(
  name: string,
  kind: SpanKind.CLIENT | SpanKind.PRODUCER,
  attributes: Attributes,
  fn: () => Promise<T>,
  // CONTRACT: Required, never defaulted to `err.message`. An AWS SDK error can
  // embed the rejected request, and `recordException` would stamp the message and
  // stack trace unsanitized — which is also why there is no recordException below.
  // See [[logging-context]]
  describeError: (err: unknown) => string,
): Promise<T> {
  return tracer.startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: describeError(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}
```

- [ ] **Step 7: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- websocket-publisher && pnpm --filter users build
```
Expected: PASS, 6 tests, and a clean build.

- [ ] **Step 8: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): add the WebSocket push for notifications

Mirrors the events-pipeline's fan-out — GSI query by cognito_sub, reactive delete
on 410 Gone, a manual PRODUCER span — rather than importing it: the two packages
have separate dependency trees, and Users reads a validated env object where the
pipeline reads process.env. publishToUser never throws, so a socket failure can
never lose a stored notification.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.5: Write the create-notification command

**Files:**
- Create: `services/users/src/features/notifications/domain/notification.ts`
- Create: `services/users/src/features/notifications/commands/create-notification.ts`
- Modify: `services/users/src/shared/audit/audit-actor.ts`
- Test: `services/users/tests/features/notifications/create-notification.test.ts`

**Interfaces:**
- Consumes: `Db` from `#shared/db/prisma`; `welcomeCopy()`, `placedCopy(input)`,
  `trackingCopy(input)`, `NotificationType`, `TrackingStatus`, `TrackingEventStatus`,
  `TRACKING_EVENT_STATUSES` from Task 3.2; `publishToUser(cognitoSub, message)` and
  `NotificationCreatedMessage` from Task 3.4; `AuditActor`; `appLogger`; `withWorkflowSpan`.
- Produces:
  - `notification.ts`: `export interface Notification { id, userId, type, title, body, metadata,
    readAt, createdAt }` and `export function toDomain(row): Notification`;
    `export interface NotificationMetadata { status?: TrackingStatus; order_id?: string;
    order_number?: string; occurred_at: string }`.
  - `create-notification.ts`: `export class CreateNotificationCommand` with
    `constructor(deps: { db: Db })` and
    `execute(envelope: NotificationEnvelope): Promise<"created" | "discarded">`;
    plus `export interface NotificationEnvelope` — the narrow shape the consumer hands it.
    **Three** event types map to a row: `USER_CREATED` → `WELCOME`, `ORDER_CREATED` → the
    `PLACED` variant, `TRACKING_STATUS_CHANGED` → the four transition variants. Everything else
    is discarded.
  - `AuditActor.NotificationCreated = "users_api:notification_created"`.
  - Task 3.6's consumer calls `execute`; Task 3.7's query reads rows it wrote.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/notifications/create-notification.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const publishToUser = vi.fn<(sub: string, message: unknown) => Promise<void>>();
vi.mock("#shared/realtime/websocket-publisher", () => ({
  publishToUser: (sub: string, message: unknown) => publishToUser(sub, message),
}));

const { CreateNotificationCommand } = await import(
  "#features/notifications/commands/create-notification"
);

// A Prisma double narrow enough to type-check against the two calls the command
// makes, and no wider — a fake that accepts anything hides a schema mismatch.
function fakeDb(overrides?: { unreadCount?: number; findUser?: { cognitoSub: string | null } | null }) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    db: {
      notification: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "ntf_test000000000000000000", ...data, readAt: null, createdAt: new Date() };
        },
        count: async () => overrides?.unreadCount ?? 1,
      },
      user: {
        findFirst: async () =>
          overrides?.findUser === undefined ? { cognitoSub: "sub-abc" } : overrides.findUser,
      },
    } as never,
  };
}

const USER_CREATED = {
  type: "USER_CREATED",
  user_id: "usr_alice",
  order_id: null,
  author: { actor: "users_api:register", user_id: "usr_alice", cognito_sub: "sub-abc" },
  payload: { email: "a@b.c", fullName: "Alice B", userId: "usr_alice", createdAt: "2026-09-10T10:00:00.000Z" },
};

// The payload ORDER_CREATED really carries, per OrderCreatedPayloadSchema at
// functions/events-pipeline/src/handlers/order-created.ts:24. Only four of its
// fields matter here; the rest ride along untouched.
const ORDER_CREATED = {
  type: "ORDER_CREATED",
  user_id: "usr_alice",
  order_id: "ord_1",
  author: { actor: "orders_api:checkout", user_id: "usr_alice", cognito_sub: "sub-abc" },
  payload: {
    order_id: "ord_1",
    order_number: { raw: "3MRAI10482", formatted: "ORD-3MRAI-10482" },
    user_id: "usr_alice",
    email: "a@b.c",
    full_name: "Alice B",
    subtotal_cents: 4200,
    tax_cents: 336,
    shipping_cents: 0,
    total_cents: 4536,
    items: [{ name: "Widget", quantity: 1, unit_price_cents: 4200 }],
    created_at: "2026-09-10T11:20:00.000Z",
  },
};

const TRACKING_SHIPPED = {
  type: "TRACKING_STATUS_CHANGED",
  user_id: "usr_alice",
  order_id: "ord_1",
  author: { actor: "tracking:carrier_webhook", cognito_sub: "sub-abc" },
  payload: {
    status: "SHIPPED",
    previous_status: "PROCESSING",
    changed_at: "2026-08-01T17:48:03",
    order_id: "ord_1",
    order_number: { raw: "3MRAI10482", formatted: "ORD-3MRAI-10482" },
  },
};

describe("CreateNotificationCommand", () => {
  beforeEach(() => {
    publishToUser.mockReset();
    publishToUser.mockResolvedValue(undefined);
  });

  it("stores a WELCOME row from USER_CREATED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(USER_CREATED as never);

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "WELCOME",
      title: "Welcome to 3MRAI!",
      body: "Your account is ready. Start exploring orders, tracking and more.",
      // CONTRACT: `createdBy` is passed EXPLICITLY. The consumer runs outside any
      // request, so the extension's AsyncLocalStorage actor is undefined and would
      // stamp null on a non-nullable column.
      createdBy: "users_api:notification_created",
    });
    // WELCOME carries no order_id, consistent with the envelope.
    expect((created[0]!.metadata as Record<string, unknown>).order_id).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).occurred_at).toBe(
      "2026-09-10T10:00:00.000Z",
    );
  });

  it("stores an ORDER_STATUS row from TRACKING_STATUS_CHANGED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
    });
    expect(created[0]!.metadata).toMatchObject({
      status: "SHIPPED",
      order_id: "ord_1",
      order_number: "ORD-3MRAI-10482",
      occurred_at: "2026-08-01T17:48:03",
    });
  });

  it("tolerates a tracking payload with no order number", async () => {
    const { db, created } = fakeDb();
    const withoutNumber = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, order_number: undefined },
    };

    await new CreateNotificationCommand({ db }).execute(withoutNumber as never);

    expect(created[0]!.body).toBe("Handed to the carrier and on its way to you.");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
  });

  // CONTRACT: ORDER_CREATED is the trigger for the PLACED variant. PLACED is never
  // emitted as a tracking status, so this is the ONLY path that writes it.
  // See [[2026-09-10-in-app-notifications-design]]
  it("stores the PLACED ORDER_STATUS row from ORDER_CREATED", async () => {
    const { db, created } = fakeDb();
    const result = await new CreateNotificationCommand({ db }).execute(ORDER_CREATED as never);

    expect(result).toBe("created");
    expect(created[0]).toMatchObject({
      userId: "usr_alice",
      type: "ORDER_STATUS",
      title: "Order placed",
      body: "ORD-3MRAI-10482 · Received and confirmed. We'll email your receipt.",
    });
    expect(created[0]!.metadata).toMatchObject({
      status: "PLACED",
      order_id: "ord_1",
      order_number: "ORD-3MRAI-10482",
      // occurred_at comes from the payload's `created_at`, the confirmed field name.
      occurred_at: "2026-09-10T11:20:00.000Z",
    });
  });

  // CONTRACT: `order_number` is `OrderNumberSchema.optional()` on ORDER_CREATED's
  // payload — an order predating the backfill omits the key entirely, and the body
  // must degrade to the bare sentence rather than rendering "undefined · ".
  it("tolerates an ORDER_CREATED payload with no order number", async () => {
    const { db, created } = fakeDb();
    const withoutNumber = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, order_number: undefined },
    };

    await new CreateNotificationCommand({ db }).execute(withoutNumber as never);

    expect(created[0]!.title).toBe("Order placed");
    expect(created[0]!.body).toBe("Received and confirmed. We'll email your receipt.");
    expect(created[0]!.body).not.toContain("undefined");
    expect((created[0]!.metadata as Record<string, unknown>).order_number).toBeUndefined();
    expect((created[0]!.metadata as Record<string, unknown>).status).toBe("PLACED");
  });

  it("discards an ORDER_CREATED payload missing created_at", async () => {
    const { db, created } = fakeDb();
    const bogus = {
      ...ORDER_CREATED,
      payload: { ...ORDER_CREATED.payload, created_at: undefined },
    };

    const result = await new CreateNotificationCommand({ db }).execute(bogus as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });

  // CONTRACT: PLACED can only ever arrive via ORDER_CREATED. A tracking event
  // carrying it is impossible in production, and accepting it here would mask a
  // producer regression — so it is discarded, not mapped.
  it("discards a TRACKING_STATUS_CHANGED carrying PLACED", async () => {
    const { db, created } = fakeDb();
    const placedTransition = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "PLACED" },
    };

    const result = await new CreateNotificationCommand({ db }).execute(placedTransition as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });

  // Defence in depth alongside the SNS filter policy. ORDER_CREATED is NOT in this
  // list any more — it is handled, per the spec's 2026-09-10 correction.
  it.each(["AUTH_OTP_REQUESTED", "PASSWORD_RESET_REQUESTED"])(
    "discards %s without writing a row",
    async (type) => {
      const { db, created } = fakeDb();
      const result = await new CreateNotificationCommand({ db }).execute({
        ...USER_CREATED,
        type,
      } as never);

      expect(result).toBe("discarded");
      expect(created).toHaveLength(0);
      expect(publishToUser).not.toHaveBeenCalled();
    },
  );

  it("pushes the notification and the unread count to the owner's sockets", async () => {
    const { db } = fakeDb({ unreadCount: 4 });
    await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

    expect(publishToUser).toHaveBeenCalledTimes(1);
    const [sub, message] = publishToUser.mock.calls[0]!;
    expect(sub).toBe("sub-abc");
    expect(message).toMatchObject({
      type: "NOTIFICATION_CREATED",
      unread_count: 4,
      notification: { type: "ORDER_STATUS", title: "Your order has shipped", read_at: null },
    });
  });

  // CONTRACT: The push must never fail the persistence.
  it("still reports created when the push throws", async () => {
    const { db, created } = fakeDb();
    publishToUser.mockRejectedValue(new Error("socket layer down"));

    const result = await new CreateNotificationCommand({ db }).execute(TRACKING_SHIPPED as never);

    expect(result).toBe("created");
    expect(created).toHaveLength(1);
  });

  // The envelope's author.cognito_sub is absent on a carrier-webhook transition,
  // so the command resolves it from its OWN users table — no remote call.
  it("resolves cognito_sub locally when the envelope omits it", async () => {
    const { db } = fakeDb();
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    await new CreateNotificationCommand({ db }).execute(noSub as never);

    expect(publishToUser).toHaveBeenCalledWith("sub-abc", expect.anything());
  });

  it("skips the push when the user has no cognito_sub at all", async () => {
    const { db, created } = fakeDb({ findUser: null });
    const noSub = { ...TRACKING_SHIPPED, author: { actor: "tracking:carrier_webhook" } };

    const result = await new CreateNotificationCommand({ db }).execute(noSub as never);

    // The row is still stored — it appears when the panel is opened.
    expect(result).toBe("created");
    expect(created).toHaveLength(1);
    expect(publishToUser).not.toHaveBeenCalled();
  });

  // An invalid payload is a PERMANENT error: logged and consumed, never thrown,
  // because retrying it to the DLQ has no chance of success.
  it("discards a tracking payload with an unknown status", async () => {
    const { db, created } = fakeDb();
    const bogus = {
      ...TRACKING_SHIPPED,
      payload: { ...TRACKING_SHIPPED.payload, status: "TELEPORTED" },
    };

    const result = await new CreateNotificationCommand({ db }).execute(bogus as never);

    expect(result).toBe("discarded");
    expect(created).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- create-notification
```
Expected: FAIL — `Cannot find module '#features/notifications/commands/create-notification'`.

- [ ] **Step 3: Add the audit actors**

In `services/users/src/shared/audit/audit-actor.ts`, add two members:
```ts
  // The SQS consumer's writes. A distinct actor from every other member here
  // because these rows originate OUTSIDE a request — `deleted_by`/`created_by`
  // record WHAT produced the change, and "an event arrived" is a different fact
  // from "a user asked".
  NotificationCreated = "users_api:notification_created",
  NotificationsMarkedRead = "users_api:notifications_marked_read",
```

- [ ] **Step 4: Write the domain type**

Create `services/users/src/features/notifications/domain/notification.ts`:
```ts
import type { TrackingStatus } from "./notification-copy.ts";

/**
 * What `metadata` carries. Presentation is DERIVED from these facts rather than
 * baked into `title`/`body`: without `status` the web could print the string but
 * choose no icon and no tint, and without `order_id` there is no "View order" CTA.
 *
 * CONTRACT: Unknown fields are OMITTED, never null. A WELCOME row genuinely has no
 * order, and `order_id: null` would read as a resolved value that happens to be
 * null. See [[logging-context]]
 */
export interface NotificationMetadata {
  status?: TrackingStatus;
  order_id?: string;
  /** The DISPLAY form (`ORD-3MRAI-10482`), omitted when the order has none. */
  order_number?: string;
  /** When the event happened, as the producer stamped it. Not indexable. */
  occurred_at: string;
}

/** One notification as the service reasons about it. */
export interface Notification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata: NotificationMetadata;
  readAt: Date | null;
  createdAt: Date;
}

/** The row shape this mapper accepts, narrowed to what it reads. */
interface NotificationRow {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata: unknown;
  readAt: Date | null;
  createdAt: Date;
}

/** Maps a Prisma row to the domain type, narrowing `metadata` from Json. */
export function toDomain(row: NotificationRow): Notification {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    title: row.title,
    body: row.body,
    metadata: (row.metadata ?? {}) as NotificationMetadata,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}
```

- [ ] **Step 5: Write the command**

Create `services/users/src/features/notifications/commands/create-notification.ts`:
```ts
import type { Db } from "#shared/db/prisma";
import { AuditActor } from "#shared/audit/audit-actor";
import { appLogger } from "#shared/logging/app-logger";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { publishToUser } from "#shared/realtime/websocket-publisher";
import {
  TRACKING_EVENT_STATUSES,
  placedCopy,
  trackingCopy,
  welcomeCopy,
  type NotificationCopy,
  type TrackingEventStatus,
} from "../domain/notification-copy.ts";
import type { NotificationMetadata } from "../domain/notification.ts";

/**
 * The three event types that produce a notification. Everything else is discarded.
 *
 * CONTRACT: ORDER_CREATED is the "order placed" trigger. PLACED is the status a
 * tracking row is CREATED in, never a transition, so no TRACKING_STATUS_CHANGED
 * ever carries it — a tracking-only mapping delivers no order-placed notification
 * at all. See [[2026-09-10-in-app-notifications-design]]
 */
const WELCOME_EVENT = "USER_CREATED";
const ORDER_PLACED_EVENT = "ORDER_CREATED";
const TRACKING_EVENT = "TRACKING_STATUS_CHANGED";

/**
 * The envelope fields this command reads. Deliberately narrower than the full wire
 * envelope: a wide type here would let a producer's unrelated field change ripple
 * into this consumer.
 */
export interface NotificationEnvelope {
  type: string;
  user_id: string;
  order_id: string | null;
  author: { actor: string; user_id?: string; cognito_sub?: string };
  payload: Record<string, unknown>;
}

/**
 * CONTRACT: Narrows to the FOUR transition statuses. `PLACED` fails this check on
 * purpose — it can only reach a row through ORDER_CREATED, so a tracking event
 * carrying it is a producer regression and must not be silently mapped.
 */
function isTrackingEventStatus(value: unknown): value is TrackingEventStatus {
  return (
    typeof value === "string" && TRACKING_EVENT_STATUSES.includes(value as TrackingEventStatus)
  );
}

/** The row a mapped event becomes, before ids and timestamps are stamped. */
interface MappedNotification {
  type: "WELCOME" | "ORDER_STATUS";
  copy: NotificationCopy;
  metadata: NotificationMetadata;
}

/**
 * Turns one event into a stored notification and pushes it to the owner's sockets.
 *
 * CONTRACT: NEVER throws on a permanent error — an unmappable event is logged and
 * reported as "discarded" so the consumer deletes the message. Throwing would
 * retry it to the DLQ with no chance of success, the same rationale as the
 * pipeline's PermanentError. See [[2026-09-10-in-app-notifications-design]]
 */
export class CreateNotificationCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(envelope: NotificationEnvelope): Promise<"created" | "discarded"> {
    return withWorkflowSpan(
      "notification_created",
      { app_event: "notification_created_started", event_type: envelope.type },
      () => this.doExecute(envelope),
    );
  }

  private async doExecute(envelope: NotificationEnvelope): Promise<"created" | "discarded"> {
    const mapped = this.map(envelope);
    if (mapped === null) return "discarded";

    // The extension stamps `id` from MODEL_ID_PREFIXES, but `createdBy` comes from
    // the AsyncLocalStorage actor — undefined outside a request — so it is passed
    // explicitly onto a non-nullable column.
    const row = await this.db.notification.create({
      data: {
        userId: envelope.user_id,
        type: mapped.type,
        title: mapped.copy.title,
        body: mapped.copy.body,
        metadata: mapped.metadata as never,
        createdBy: AuditActor.NotificationCreated,
      },
    });

    appLogger.info(
      {
        app_event: "notification_created_succeeded",
        event_type: envelope.type,
        notification_id: row.id,
        user_id: envelope.user_id,
        ...(mapped.metadata.order_id ? { order_id: mapped.metadata.order_id } : {}),
      },
      "notification created",
    );

    // CONTRACT: After the insert, and never allowed to fail it. publishToUser
    // swallows its own errors; this catch covers the count query and the sub
    // lookup, so a read failure cannot lose a row that is already committed.
    try {
      await this.push(envelope, row);
    } catch (err) {
      appLogger.error(
        {
          err,
          app_event: "notification_push_failed",
          reason: "push_preparation_failed",
          notification_id: row.id,
          user_id: envelope.user_id,
        },
        "notification stored but not pushed",
      );
    }

    return "created";
  }

  /** Maps an event to a row, or null when it produces no notification. */
  private map(envelope: NotificationEnvelope): MappedNotification | null {
    if (envelope.type === WELCOME_EVENT) {
      const createdAt = envelope.payload.createdAt;
      return {
        type: "WELCOME",
        copy: welcomeCopy(),
        metadata: {
          occurred_at: typeof createdAt === "string" ? createdAt : new Date().toISOString(),
        },
      };
    }

    if (envelope.type === ORDER_PLACED_EVENT) {
      // The payload is OrderCreatedPayloadSchema
      // (functions/events-pipeline/src/handlers/order-created.ts). Only four of its
      // fields are read here; `created_at` is the occurred_at source and
      // `order_number.formatted` the body prefix — both confirmed field names.
      const createdAt = envelope.payload.created_at;
      if (typeof createdAt !== "string" || createdAt.length === 0) {
        // A permanent error: logged and consumed. `reason` names the field.
        appLogger.error(
          {
            app_event: "notification_created_failed",
            reason: "missing_created_at",
            event_type: envelope.type,
            user_id: envelope.user_id,
          },
          "ORDER_CREATED carried no created_at",
        );
        return null;
      }

      // CONTRACT: `order_number` is OPTIONAL on this payload, exactly as on the
      // tracking one — an order predating the backfill omits the key entirely, so
      // only the display form is read and its absence must degrade cleanly.
      const orderNumber = envelope.payload.order_number as { formatted?: string } | undefined;
      const formatted = orderNumber?.formatted;
      const orderId =
        envelope.order_id ??
        (typeof envelope.payload.order_id === "string" ? envelope.payload.order_id : undefined);

      return {
        type: "ORDER_STATUS",
        copy: placedCopy({ orderNumberFormatted: formatted }),
        metadata: {
          // Stored identically to the four tracking-driven rows — only the
          // triggering event differs, and nothing downstream needs to know which.
          status: "PLACED",
          ...(orderId ? { order_id: orderId } : {}),
          ...(formatted ? { order_number: formatted } : {}),
          occurred_at: createdAt,
        },
      };
    }

    if (envelope.type === TRACKING_EVENT) {
      const status = envelope.payload.status;
      if (!isTrackingEventStatus(status)) {
        // A permanent error: logged and consumed. `reason` names the field.
        appLogger.error(
          {
            app_event: "notification_created_failed",
            reason: "unknown_tracking_status",
            event_type: envelope.type,
            user_id: envelope.user_id,
          },
          // PLACED lands here too, and correctly so: it is never a transition.
          "TRACKING_STATUS_CHANGED carried an unmappable status",
        );
        return null;
      }

      const changedAt = envelope.payload.changed_at;
      const occurredAt = typeof changedAt === "string" ? changedAt : new Date().toISOString();
      // `order_number` is an object on the wire and OMITTED when the order has
      // none; only its display form is stored.
      const orderNumber = envelope.payload.order_number as { formatted?: string } | undefined;
      const formatted = orderNumber?.formatted;
      const orderId = envelope.order_id ?? undefined;

      return {
        type: "ORDER_STATUS",
        copy: trackingCopy({ status, orderNumberFormatted: formatted, changedAt: occurredAt }),
        metadata: {
          status,
          ...(orderId ? { order_id: orderId } : {}),
          ...(formatted ? { order_number: formatted } : {}),
          occurred_at: occurredAt,
        },
      };
    }

    // Defence in depth: the SNS filter policy should have kept this off the queue.
    appLogger.info(
      { app_event: "notification_discarded", reason: "not_a_notification_type", event_type: envelope.type },
      "event type produces no notification",
    );
    return null;
  }

  /** Resolves the owner's Cognito sub and pushes the frame. */
  private async push(
    envelope: NotificationEnvelope,
    row: { id: string; type: string; title: string; body: string; metadata: unknown; readAt: Date | null },
  ): Promise<void> {
    // CONTRACT: The socket registry is keyed by `cognito_sub`, never the internal
    // `usr_` id. Prefer the envelope's, which the producer read off the persisted
    // row; a carrier-webhook transition omits it, so fall back to a local SELECT
    // on this service's own users table — no remote call.
    // See [[user-id-vs-cognito-sub-ownership-key]]
    let cognitoSub = envelope.author.cognito_sub;
    if (!cognitoSub) {
      const user = await this.db.user.findFirst({
        where: { id: envelope.user_id },
        select: { cognitoSub: true },
      });
      cognitoSub = user?.cognitoSub ?? undefined;
    }

    if (!cognitoSub) {
      // Not an error: a user with no Cognito identity has no socket to push to,
      // and the row is served the next time the panel is opened.
      return;
    }

    const unreadCount = await this.db.notification.count({
      where: { userId: envelope.user_id, readAt: null },
    });

    await publishToUser(cognitoSub, {
      type: "NOTIFICATION_CREATED",
      notification: {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        metadata: row.metadata,
        read_at: row.readAt ? row.readAt.toISOString() : null,
      },
      unread_count: unreadCount,
    });
  }
}
```

- [ ] **Step 6: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- create-notification && pnpm --filter users build
```
Expected: PASS, 15 tests, clean build.

- [ ] **Step 7: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): map events to notification rows and push them

Maps three event types: USER_CREATED to WELCOME, ORDER_CREATED to the PLACED
variant (PLACED is never emitted as a tracking status, so ORDER_CREATED is the
order-placed trigger), and TRACKING_STATUS_CHANGED to the four transition
variants. Discards everything else in code as defence in depth alongside the SNS
filter policy, never throws on a permanent error (an unmappable event is logged and
consumed), passes createdBy explicitly because the consumer runs outside any
request, and resolves cognito_sub from the local users table when the envelope
omits it.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.6: Wire the SQS consumer into the process

**Files:**
- Create: `services/users/src/features/notifications/messaging/notification-consumer.ts`
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Modify: `services/users/src/server.ts`
- Modify: `services/users/package.json` (`sqs-consumer`)
- Test: `services/users/tests/features/notifications/notification-consumer.test.ts`

**Interfaces:**
- Consumes: `CreateNotificationCommand` with `execute(envelope): Promise<"created" | "discarded">`
  (Task 3.5); `env.NOTIFICATIONS_QUEUE_URL`; `sqsClient: SQSClient` from the cradle; `appLogger`.
- Produces:
  - `export class NotificationConsumer` with `constructor(deps: { sqsClient: SQSClient; env: Env;
    createNotificationCommand: CreateNotificationCommand })`, `start(): void`, `stop(): void`,
    and `handleMessage(message: Message): Promise<void>` (exposed so a test drives one message
    without a queue).
  - Cradle gains `notificationConsumer: NotificationConsumer` and
    `createNotificationCommand: CreateNotificationCommand`.
  - `server.ts` starts it and stops it on `SIGTERM`.

**CRITICAL — where the consumer starts.** The spec says the consumer is "registered as a Fastify
plugin". `server.ts` carries an explicit CONTRACT for the metrics poller: *"Start the metrics poller
here, NOT in buildApp() — the test suite calls buildApp too, and a live timer in every run would hit
the database outside any test's control."* **The consumer has exactly this hazard**, and worse: an
SQS long-poll started inside `buildApp()` would open a real connection in every Vitest run and
consume real messages outside any test's control. So it is constructed in the container and
**started in `server.ts`**, resolved from `app.diContainer` and stopped on `SIGTERM` — the same
pattern, for the same documented reason. This is a faithful refinement of the spec's intent (one
process, shared container, shared Prisma client and logger, stopped on shutdown), not a deviation.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/notifications/notification-consumer.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { NotificationConsumer } from "#features/notifications/messaging/notification-consumer";
import { parseEnv } from "#shared/config/env";

const env = parseEnv({ ...process.env });

// Drives handleMessage directly: the point is the record-handling contract, not
// sqs-consumer's polling, which is the library's own tested behaviour.
function build(execute = vi.fn().mockResolvedValue("created")) {
  const consumer = new NotificationConsumer({
    sqsClient: {} as never,
    env,
    createNotificationCommand: { execute } as never,
  });
  return { consumer, execute };
}

function sqsMessage(envelope: unknown, traceparent?: string) {
  return {
    MessageId: "msg-1",
    Body: JSON.stringify(envelope),
    ...(traceparent
      ? {
          MessageAttributes: {
            traceparent: { DataType: "String", StringValue: traceparent },
          },
        }
      : {}),
  };
}

const ENVELOPE = {
  event_id: "evt_1",
  type: "USER_CREATED",
  source: "users",
  user_id: "usr_alice",
  order_id: null,
  author: { actor: "users_api:register", user_id: "usr_alice" },
  payload: { email: "a@b.c", fullName: "A B", userId: "usr_alice", createdAt: "2026-09-10T10:00:00.000Z" },
};

describe("NotificationConsumer.handleMessage", () => {
  it("hands a valid envelope to the command", async () => {
    const { consumer, execute } = build();

    await consumer.handleMessage(sqsMessage(ENVELOPE) as never);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toMatchObject({ type: "USER_CREATED", user_id: "usr_alice" });
  });

  // CONTRACT: A permanent error must NOT throw — throwing keeps the message on the
  // queue until it reaches the DLQ, with no chance of ever succeeding.
  it("swallows a body that is not JSON", async () => {
    const { consumer, execute } = build();

    await expect(
      consumer.handleMessage({ MessageId: "msg-2", Body: "not json at all" } as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("swallows an envelope missing its required fields", async () => {
    const { consumer, execute } = build();

    await expect(
      consumer.handleMessage(sqsMessage({ type: "USER_CREATED" }) as never),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("swallows an empty body", async () => {
    const { consumer, execute } = build();

    await expect(consumer.handleMessage({ MessageId: "msg-3" } as never).then(() => undefined))
      .resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  // CONTRACT: A TRANSIENT failure MUST throw, so the message becomes visible again
  // and is retried. Swallowing it would delete a message that could have succeeded.
  it("rethrows when the command fails unexpectedly", async () => {
    const { consumer } = build(vi.fn().mockRejectedValue(new Error("database unreachable")));

    await expect(consumer.handleMessage(sqsMessage(ENVELOPE) as never)).rejects.toThrow(
      "database unreachable",
    );
  });

  it("continues the trace from the traceparent attribute", async () => {
    const { consumer, execute } = build();
    const traceId = "0af7651916cd43dd8448eb211c80319c";

    await consumer.handleMessage(
      sqsMessage(ENVELOPE, `00-${traceId}-b7ad6b7169203331-01`) as never,
    );

    // The command ran inside the extracted context, so the active span at the
    // call site belongs to the producer's trace rather than a fresh one.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(consumer.lastTraceId).toBe(traceId);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- notification-consumer
```
Expected: FAIL — `Cannot find module '#features/notifications/messaging/notification-consumer'`.

- [ ] **Step 3: Install `sqs-consumer`**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users add sqs-consumer
```
Expected: `sqs-consumer` added to `services/users/package.json`.

- [ ] **Step 4: Write the consumer**

Create `services/users/src/features/notifications/messaging/notification-consumer.ts`:
```ts
import type { SQSClient, Message } from "@aws-sdk/client-sqs";
import { Consumer } from "sqs-consumer";
import { context, propagation, trace } from "@opentelemetry/api";
import { z } from "zod/v4";
import type { Env } from "#shared/config/env";
import { appLogger } from "#shared/logging/app-logger";
import { runWithLogContext } from "#shared/logging/log-context";
import type { CreateNotificationCommand } from "../commands/create-notification.ts";
import type { NotificationEnvelope } from "../commands/create-notification.ts";

// CONTRACT: The narrow slice of the envelope this consumer needs, and no more.
// Validating the whole wire contract here would reject a message the producers
// legitimately extend — the pipeline owns that schema, this one only needs enough
// to route and attribute the notification.
const EnvelopeSchema = z.object({
  type: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().nullable().default(null),
  author: z.object({
    actor: z.string().min(1),
    user_id: z.string().min(1).optional(),
    cognito_sub: z.string().min(1).optional(),
  }),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * Consumes the notifications queue inside the Users process, sharing the Awilix
 * container, Prisma client and logger with the HTTP surface.
 *
 * CONTRACT: Constructed here but STARTED in server.ts, never in buildApp(). The
 * test suite calls buildApp too, and a live long-poll in every run would receive
 * and DELETE real messages outside any test's control — the same reason the metrics
 * poller is started there. See [[2026-09-10-in-app-notifications-design]]
 */
export class NotificationConsumer {
  private readonly consumer: Consumer;
  private readonly createNotificationCommand: CreateNotificationCommand;

  /** The trace id of the last handled message. Read by the trace-continuity test. */
  lastTraceId: string | undefined;

  constructor(deps: {
    sqsClient: SQSClient;
    env: Env;
    createNotificationCommand: CreateNotificationCommand;
  }) {
    this.createNotificationCommand = deps.createNotificationCommand;

    this.consumer = Consumer.create({
      queueUrl: deps.env.NOTIFICATIONS_QUEUE_URL,
      sqs: deps.sqsClient,
      // CONTRACT: `traceparent` must be requested explicitly — SQS omits message
      // attributes unless asked, and the trace would silently start fresh here.
      messageAttributeNames: ["All"],
      // Long-poll rather than spin: one request per 20s idle window instead of
      // one per iteration.
      waitTimeSeconds: 20,
      batchSize: 10,
      handleMessage: (message) => this.handleMessage(message),
    });

    // sqs-consumer emits rather than throws; without a listener an error here is
    // an unhandled 'error' event that takes the process down.
    this.consumer.on("error", (err) => {
      appLogger.error(
        { err, app_event: "notification_consumer_failed", reason: "sqs_error" },
        "notifications consumer error",
      );
    });
    this.consumer.on("processing_error", (err) => {
      appLogger.error(
        { err, app_event: "notification_consumer_failed", reason: "processing_error" },
        "notifications consumer failed to process a message",
      );
    });
  }

  start(): void {
    this.consumer.start();
    appLogger.info(
      { app_event: "notification_consumer_started" },
      "notifications consumer polling",
    );
  }

  stop(): void {
    this.consumer.stop();
    appLogger.info(
      { app_event: "notification_consumer_stopped" },
      "notifications consumer stopped",
    );
  }

  /**
   * Handles one message.
   *
   * CONTRACT: Throw ONLY on a transient failure. sqs-consumer deletes the message
   * when this resolves, which is the zero-cost mitigation the design calls for —
   * the insert commits before the delete, narrowing the duplicate window to a
   * crash between the two. A permanent error (unparseable body, invalid envelope)
   * is logged and RESOLVED, because retrying it to the DLQ cannot succeed.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  async handleMessage(message: Message): Promise<void> {
    const parsed = this.parse(message);
    if (parsed === null) return;

    // Continue the producer's trace, as the pipeline does. With no traceparent
    // this yields the ambient (root) context, so the work is still traced.
    const carrier = this.carrier(message);
    const parentContext = propagation.extract(context.active(), carrier);
    this.lastTraceId = trace.getSpanContext(parentContext)?.traceId;

    return context.with(parentContext, () =>
      // The request_id seam every other flow in this service carries; there is no
      // HTTP request here, so the log context is seeded from the message instead.
      runWithLogContext(
        {
          user_id: parsed.user_id,
          ...(message.MessageId ? { request_id: message.MessageId } : {}),
        },
        async () => {
          await this.createNotificationCommand.execute(parsed);
        },
      ),
    );
  }

  /** The envelope, or null when the message can never be processed. */
  private parse(message: Message): NotificationEnvelope | null {
    if (!message.Body) {
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "empty_body",
          message_id: message.MessageId,
        },
        "notifications message carried no body",
      );
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message.Body);
    } catch {
      // WARNING: Do NOT log the body — it carries the recipient's email.
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "body_not_json",
          message_id: message.MessageId,
        },
        "notifications message body is not JSON",
      );
      return null;
    }

    const result = EnvelopeSchema.safeParse(raw);
    if (!result.success) {
      // Field PATHS only: a raw Zod message echoes the rejected values, and those
      // include the email. See [[logging-context]]
      appLogger.error(
        {
          app_event: "notification_created_failed",
          reason: "invalid_envelope",
          fields: result.error.issues.map((issue) => issue.path.join(".")).join(", "),
          message_id: message.MessageId,
        },
        "notifications message failed envelope validation",
      );
      return null;
    }

    return result.data;
  }

  /** The W3C carrier from the message attributes, empty when none rode along. */
  private carrier(message: Message): Record<string, string> {
    const attributes = message.MessageAttributes ?? {};
    const carrier: Record<string, string> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value.StringValue) carrier[key] = value.StringValue;
    }
    return carrier;
  }
}
```

- [ ] **Step 5: Register it in the container**

In `services/users/src/shared/di/awilix-container.ts`, add the imports:
```ts
import { CreateNotificationCommand } from "#features/notifications/commands/create-notification";
import { NotificationConsumer } from "#features/notifications/messaging/notification-consumer";
```
Add to `Cradle`:
```ts
    createNotificationCommand: CreateNotificationCommand;
    notificationConsumer: NotificationConsumer;
```
Add to `registerSingletons()`:
```ts
    // SINGLETON because it owns one long-poll loop: a second instance would mean
    // two consumers competing for the same queue. Registered here but NEVER
    // started here — `server.ts` starts it, so the test suite's buildApp() never
    // opens a live poll against a real queue.
    notificationConsumer: asClass(NotificationConsumer, { lifetime: Lifetime.SINGLETON }),
```
Add to `registerServices()`:
```ts
    // SCOPED like every other command, and resolved by the consumer per message.
    createNotificationCommand: asClass(CreateNotificationCommand, { lifetime: Lifetime.SCOPED }),
```

**CONTRACT:** `asClass` is correct for both — every name their constructors destructure
(`db`, `sqsClient`, `env`, `createNotificationCommand`) is a registered cradle key. Compare
`metricsPublisher`, which needs `asFunction` because its constructor takes `{ client }` and no
`client` is registered.

- [ ] **Step 6: Start it in `server.ts`**

In `services/users/src/server.ts`, replace the `SIGTERM` block:
```ts
// CONTRACT: Start the metrics poller and the notifications consumer here, NOT in
// buildApp() — the test suite calls buildApp too, and a live timer or a live SQS
// long-poll in every run would hit the database and DELETE real messages outside
// any test's control. The SCOPED `userQueryService` resolves safely from the root
// container because its only dependency is a root singleton.
const businessMetricsPoller = app.diContainer.resolve("businessMetricsPoller");
businessMetricsPoller.start();

const notificationConsumer = app.diContainer.resolve("notificationConsumer");
notificationConsumer.start();

process.on("SIGTERM", () => {
  businessMetricsPoller.stop();
  notificationConsumer.stop();
});
```

- [ ] **Step 7: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test && pnpm --filter users build && pnpm --filter users lint
```
Expected: all tests pass (6 new), clean build and lint. **If the suite hangs, the consumer is
being started somewhere `buildApp` reaches** — that is the exact hazard this task's contract
guards, so grep for `notificationConsumer` outside `server.ts` and the container.

- [ ] **Step 8: Confirm it drains the real queue**

Phase 2's Task 2.5 left messages accumulating on the notifications queue. Starting the consumer
should drain them.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
NOTIF_URL="$(cd infra/environments/local && terraform output -raw notifications_queue_url)"
aws --endpoint-url http://localhost:4566 sqs get-queue-attributes --queue-url "$NOTIF_URL" \
  --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages'
docker compose up -d --build users
sleep 25
aws --endpoint-url http://localhost:4566 sqs get-queue-attributes --queue-url "$NOTIF_URL" \
  --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages'
docker compose logs users --tail 40 | grep -E 'notification_consumer_started|notification_created_succeeded|notification_created_failed'
```
Expected: the depth drops toward `"0"`, the logs carry `notification_consumer_started` and one
`notification_created_succeeded` per message. A depth that does not move means the consumer never
started or cannot reach the queue — check `NOTIFICATIONS_QUEUE_URL` in `.env.local.users`.

- [ ] **Step 9: Confirm the rows landed with the right shape**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
pgport="$(.venv/bin/python infra/scripts/discover_db_port.py postgres)"
docker run --rm --network 3mrai_3mrai-network -e PGPASSWORD=test postgres:16-alpine \
  psql -h floci -p "$pgport" -U test -d users -c \
  "SELECT id, type, title, left(body, 48) AS body, created_by, read_at, metadata FROM notifications ORDER BY created_at DESC LIMIT 5;"
```
Expected: rows with `ntf_`-prefixed ids, `type` in (`WELCOME`, `ORDER_STATUS`),
`created_by = users_api:notification_created`, `read_at` NULL, and a `metadata` object carrying
`occurred_at`. A `created_by` of NULL would have failed the non-null constraint — its presence
confirms the explicit stamp works.

- [ ] **Step 10: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): consume the notifications queue in-process

sqs-consumer sharing the Awilix container, Prisma client and logger with the HTTP
surface. Started in server.ts rather than buildApp(), for the same documented
reason the metrics poller is: the test suite calls buildApp, and a live long-poll
would consume real messages outside any test's control. Continues the producer's
trace from the traceparent attribute; a permanent error is logged and consumed
rather than retried to the DLQ.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 3.7: Write the list query and the mark-read command

**Files:**
- Create: `services/users/src/features/notifications/queries/list-notifications.ts`
- Create: `services/users/src/features/notifications/commands/mark-notifications-read.ts`
- Test: `services/users/tests/features/notifications/list-notifications.test.ts`
- Test: `services/users/tests/features/notifications/mark-notifications-read.test.ts`

**Interfaces:**
- Consumes: `Db`; `CurrentUser` with `resolve(): Promise<{ id: string } | null>` and
  `identity: string`; `AuditActor.NotificationsMarkedRead`; `toDomain`, `Notification`;
  `withWorkflowSpan`; `appLogger`.
- Produces:
  - `export const NOTIFICATIONS_LIMIT = 50` and `export const WINDOW_DAYS = 90` — imported by
    Task 3.8's schemas so the cap is declared once.
  - `export type NotificationFilter = "all" | "unread" | "read"`
  - `export class NotificationQueryService` with `constructor(deps: { db: Db })` and
    `list(currentUser: CurrentUser, filter: NotificationFilter): Promise<NotificationsPage>`
    plus `unreadCount(currentUser: CurrentUser): Promise<number>`, where
    `export interface NotificationsPage { items: Notification[]; unread_count: number;
    window_total: number; window_days: number }`.
  - `export class MarkNotificationsReadCommand` with `constructor(deps: { db: Db })` and
    `execute(currentUser: CurrentUser, ids: string[]): Promise<{ updated: number; unread_count: number }>`.

- [ ] **Step 1: Write the failing list test**

Create `services/users/tests/features/notifications/list-notifications.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import {
  NOTIFICATIONS_LIMIT,
  WINDOW_DAYS,
  NotificationQueryService,
} from "#features/notifications/queries/list-notifications";

function row(id: string, readAt: Date | null) {
  return {
    id,
    userId: "usr_alice",
    type: "ORDER_STATUS",
    title: "Your order has shipped",
    body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
    metadata: { status: "SHIPPED", occurred_at: "2026-08-01T17:48:03" },
    readAt,
    createdAt: new Date("2026-08-01T17:48:03Z"),
  };
}

function fakeDb(rows = [row("ntf_1", null)], counts = { unread: 1, window: 1 }) {
  const findManyArgs: Array<Record<string, unknown>> = [];
  const countArgs: Array<Record<string, unknown>> = [];
  return {
    findManyArgs,
    countArgs,
    db: {
      notification: {
        findMany: async (args: Record<string, unknown>) => {
          findManyArgs.push(args);
          return rows;
        },
        count: async (args: Record<string, unknown>) => {
          countArgs.push(args);
          // The unread count is the one filtered on readAt: null.
          const where = args.where as Record<string, unknown>;
          return where.readAt === null ? counts.unread : counts.window;
        },
      },
    } as never,
  };
}

const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) } as never;

describe("NotificationQueryService.list", () => {
  it("returns the newest 50 by createdAt desc, scoped to the caller", async () => {
    const { db, findManyArgs } = fakeDb();
    const page = await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(findManyArgs[0]).toMatchObject({
      where: { userId: "usr_alice" },
      orderBy: { createdAt: "desc" },
      take: NOTIFICATIONS_LIMIT,
    });
    expect(page.items).toHaveLength(1);
    expect(page.window_days).toBe(WINDOW_DAYS);
  });

  it("caps the list at 50", () => {
    expect(NOTIFICATIONS_LIMIT).toBe(50);
  });

  // CONTRACT: The list query carries NO date bound — only window_total is scoped
  // to 90 days. A date-filtered list would hide the WELCOME row the All screen
  // shows in its EARLIER group.
  it("applies no date bound to the list itself", async () => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(JSON.stringify(findManyArgs[0]!.where)).not.toContain("createdAt");
  });

  it.each([
    ["unread", null],
    ["read", { not: null }],
  ] as const)("filters %s on readAt", async (filter, expected) => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, filter);

    expect((findManyArgs[0]!.where as Record<string, unknown>).readAt).toEqual(expected);
  });

  it("does not filter on readAt for all", async () => {
    const { db, findManyArgs } = fakeDb();
    await new NotificationQueryService({ db }).list(currentUser, "all");

    expect("readAt" in (findManyArgs[0]!.where as Record<string, unknown>)).toBe(false);
  });

  // CONTRACT: window_total is a 90-day count WITHOUT the cap, so it can exceed
  // items.length. That divergence is exactly why the counters are separate.
  it("counts the 90-day window without the cap", async () => {
    const { db, countArgs } = fakeDb([row("ntf_1", null)], { unread: 3, window: 120 });
    const page = await new NotificationQueryService({ db }).list(currentUser, "all");

    expect(page.unread_count).toBe(3);
    expect(page.window_total).toBe(120);
    expect(page.window_total).toBeGreaterThan(page.items.length);

    const windowCall = countArgs.find(
      (args) => (args.where as Record<string, unknown>).readAt !== null,
    );
    expect(JSON.stringify(windowCall!.where)).toContain("createdAt");
  });

  it("returns an empty page for a caller with no user row", async () => {
    const { db } = fakeDb();
    const unknown = { identity: "sub-nobody", resolve: async () => null } as never;
    const page = await new NotificationQueryService({ db }).list(unknown, "all");

    expect(page).toEqual({ items: [], unread_count: 0, window_total: 0, window_days: WINDOW_DAYS });
  });
});
```

- [ ] **Step 2: Write the failing mark-read test**

Create `services/users/tests/features/notifications/mark-notifications-read.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MarkNotificationsReadCommand } from "#features/notifications/commands/mark-notifications-read";

function fakeDb(updatedCount = 2, unreadAfter = 1) {
  const updateManyArgs: Array<Record<string, unknown>> = [];
  return {
    updateManyArgs,
    db: {
      notification: {
        updateMany: async (args: Record<string, unknown>) => {
          updateManyArgs.push(args);
          return { count: updatedCount };
        },
        count: async () => unreadAfter,
      },
    } as never,
  };
}

const currentUser = { identity: "sub-abc", resolve: async () => ({ id: "usr_alice" }) } as never;

describe("MarkNotificationsReadCommand", () => {
  it("stamps read_at on the caller's unread rows only", async () => {
    const { db, updateManyArgs } = fakeDb();
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, [
      "ntf_1",
      "ntf_2",
    ]);

    expect(result).toEqual({ updated: 2, unread_count: 1 });
    const where = updateManyArgs[0]!.where as Record<string, unknown>;
    // CONTRACT: The user_id clause IS the ownership check — another user's ids
    // simply do not match and are not counted.
    expect(where).toMatchObject({ id: { in: ["ntf_1", "ntf_2"] }, userId: "usr_alice" });
    // CONTRACT: readAt IS NULL makes it idempotent, which matters because
    // mark-on-enter can fire twice on an Angular remount.
    expect(where.readAt).toBeNull();
  });

  // An empty list is the NORMAL case: arriving with nothing unread.
  it("returns 200-shaped zero for an empty id list without touching the db", async () => {
    const { db, updateManyArgs } = fakeDb();
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, []);

    expect(result.updated).toBe(0);
    expect(updateManyArgs).toHaveLength(0);
  });

  it("reports zero updated when the ids belong to someone else", async () => {
    const { db } = fakeDb(0, 5);
    const result = await new MarkNotificationsReadCommand({ db }).execute(currentUser, ["ntf_x"]);

    expect(result).toEqual({ updated: 0, unread_count: 5 });
  });

  it("returns zero for a caller with no user row", async () => {
    const { db, updateManyArgs } = fakeDb();
    const unknown = { identity: "sub-nobody", resolve: async () => null } as never;
    const result = await new MarkNotificationsReadCommand({ db }).execute(unknown, ["ntf_1"]);

    expect(result).toEqual({ updated: 0, unread_count: 0 });
    expect(updateManyArgs).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run both and see them fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- list-notifications mark-notifications-read
```
Expected: FAIL — both modules cannot be found.

- [ ] **Step 4: Write the query service**

Create `services/users/src/features/notifications/queries/list-notifications.ts`:
```ts
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";
import { toDomain, type Notification } from "../domain/notification.ts";

/**
 * CONTRACT: A hard cap with NO pagination, by decision. `window_total` is computed
 * separately so the count pill stays exact when the cap truncates the list.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const NOTIFICATIONS_LIMIT = 50;

/**
 * CONTRACT: 90 days bounds `window_total` ONLY. The list query has NO date bound —
 * a date-filtered list would hide an old WELCOME row the All screen shows in its
 * EARLIER group. This is easy to get backwards, which is why it is stated here.
 */
export const WINDOW_DAYS = 90;

export type NotificationFilter = "all" | "unread" | "read";

export interface NotificationsPage {
  items: Notification[];
  unread_count: number;
  window_total: number;
  window_days: number;
}

const EMPTY_PAGE: NotificationsPage = {
  items: [],
  unread_count: 0,
  window_total: 0,
  window_days: WINDOW_DAYS,
};

/** Translates a filter into the `readAt` clause, or nothing for "all". */
function readAtClause(filter: NotificationFilter): { readAt?: null | { not: null } } {
  if (filter === "unread") return { readAt: null };
  if (filter === "read") return { readAt: { not: null } };
  return {};
}

export class NotificationQueryService {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async list(currentUser: CurrentUser, filter: NotificationFilter): Promise<NotificationsPage> {
    return withWorkflowSpan(
      "list_notifications",
      { app_event: "list_notifications_started", notification_filter: filter },
      () => this.doList(currentUser, filter),
    );
  }

  private async doList(
    currentUser: CurrentUser,
    filter: NotificationFilter,
  ): Promise<NotificationsPage> {
    const span = trace.getActiveSpan();
    // Resolves the raw x-user-id (a Cognito sub or a usr_ id) to the internal id
    // and enriches the log context with `user_id` as a side effect.
    const user = await currentUser.resolve();
    if (!user) {
      // A routine outcome (a valid token whose user was deleted), not an error, so
      // the span status stays OK and the distinction rides on app_event.
      span?.setAttributes({ app_event: "list_notifications_failed", reason: "user_not_found" });
      return EMPTY_PAGE;
    }

    const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // Soft-deleted rows are excluded automatically by the query extension, and
    // reads are routed to the replica. See [[soft-delete]]
    const [rows, unreadCount, windowTotal] = await Promise.all([
      this.db.notification.findMany({
        where: { userId: user.id, ...readAtClause(filter) },
        orderBy: { createdAt: "desc" },
        take: NOTIFICATIONS_LIMIT,
      }),
      this.db.notification.count({ where: { userId: user.id, readAt: null } }),
      this.db.notification.count({
        where: { userId: user.id, createdAt: { gte: windowStart } },
      }),
    ]);

    span?.setAttributes({
      app_event: "list_notifications_succeeded",
      user_id: user.id,
      notification_count: rows.length,
    });

    return {
      items: rows.map(toDomain),
      unread_count: unreadCount,
      window_total: windowTotal,
      window_days: WINDOW_DAYS,
    };
  }

  /** The badge count on its own, for the dedicated endpoint. */
  async unreadCount(currentUser: CurrentUser): Promise<number> {
    const user = await currentUser.resolve();
    if (!user) return 0;
    return this.db.notification.count({ where: { userId: user.id, readAt: null } });
  }
}
```

- [ ] **Step 5: Write the mark-read command**

Create `services/users/src/features/notifications/commands/mark-notifications-read.ts`:
```ts
import { trace } from "@opentelemetry/api";
import type { Db } from "#shared/db/prisma";
import type { CurrentUser } from "#shared/auth/current-user";
import { AuditActor } from "#shared/audit/audit-actor";
import { withWorkflowSpan } from "#shared/observability/workflow-tracing";

export interface MarkReadResult {
  updated: number;
  unread_count: number;
}

/**
 * Marks a list of the caller's notifications read.
 *
 * CONTRACT: One write endpoint covers all three cases — entering the All screen,
 * "Mark all as read", and marking a single one (a list of one). There is
 * deliberately no separate read-all route.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export class MarkNotificationsReadCommand {
  private readonly db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async execute(currentUser: CurrentUser, ids: string[]): Promise<MarkReadResult> {
    return withWorkflowSpan(
      "notifications_marked_read",
      { app_event: "notifications_marked_read_started", requested_count: ids.length },
      () => this.doExecute(currentUser, ids),
    );
  }

  private async doExecute(currentUser: CurrentUser, ids: string[]): Promise<MarkReadResult> {
    const span = trace.getActiveSpan();
    const user = await currentUser.resolve();
    if (!user) {
      span?.setAttributes({
        app_event: "notifications_marked_read_failed",
        reason: "user_not_found",
      });
      return { updated: 0, unread_count: 0 };
    }

    // An empty list is the NORMAL case — arriving with nothing unread — so it
    // short-circuits rather than issuing an UPDATE matching nothing.
    if (ids.length === 0) {
      const unreadCount = await this.db.notification.count({
        where: { userId: user.id, readAt: null },
      });
      span?.setAttributes({
        app_event: "notifications_marked_read_succeeded",
        user_id: user.id,
        updated_count: 0,
      });
      return { updated: 0, unread_count: unreadCount };
    }

    // CONTRACT: `userId` IS the ownership check — another user's ids simply do not
    // match and are not counted, which is what keeps a single-id PATCH from
    // leaking the existence of someone else's notification. `readAt: null` makes
    // the write idempotent, and that matters because the web's mark-on-enter can
    // fire twice on an Angular remount.
    const { count } = await this.db.notification.updateMany({
      where: { id: { in: ids }, userId: user.id, readAt: null },
      data: { readAt: new Date(), updatedBy: AuditActor.NotificationsMarkedRead },
    });

    const unreadCount = await this.db.notification.count({
      where: { userId: user.id, readAt: null },
    });

    span?.setAttributes({
      app_event: "notifications_marked_read_succeeded",
      user_id: user.id,
      updated_count: count,
    });

    return { updated: count, unread_count: unreadCount };
  }
}
```

- [ ] **Step 6: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- list-notifications mark-notifications-read
```
Expected: PASS, 12 tests.

- [ ] **Step 7: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): add the notification list query and the mark-read command

Newest 50 with no date bound; window_total is a separate 90-day count so it can
exceed items.length. The mark-read write is scoped by user_id (the ownership check)
and by read_at IS NULL (idempotent, because mark-on-enter can fire twice).

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.8: Expose the three HTTP endpoints

**Files:**
- Create: `services/users/src/features/notifications/http/schemas.ts`
- Modify: `services/users/src/features/users/http/routes.ts` (inside the existing `app.after()`
  block, after the `PATCH /v1/users/me/password` route)
- Modify: `services/users/src/shared/di/awilix-container.ts`
- Test: `services/users/tests/features/notifications/routes.test.ts`

**Interfaces:**
- Consumes: `NotificationQueryService.list(currentUser, filter)` / `.unreadCount(currentUser)`,
  `MarkNotificationsReadCommand.execute(currentUser, ids)`, `NOTIFICATIONS_LIMIT`, `WINDOW_DAYS`
  (Task 3.7); the existing `buildApp` scaffolding (`fastify-type-provider-zod`, the `onRequest`
  auth hook, `UserIdHeader`, `ErrorSchema`).
- Produces:
  - `schemas.ts`: `NotificationSchema`, `NotificationsPageSchema`, `UnreadCountSchema`,
    `MarkReadInputSchema`, `MarkReadResultSchema`, `NotificationFilterQuerySchema`.
  - Three routes: `GET /v1/notifications`, `GET /v1/notifications/unread-count`,
    `PATCH /v1/notifications/read`.
  - Cradle gains `notificationQueryService: NotificationQueryService` and
    `markNotificationsReadCommand: MarkNotificationsReadCommand`.
  - Phase 4's `NotificationsApi` binds to exactly these paths and response shapes.

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/notifications/routes.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { asValue, createContainer, InjectionMode, type AwilixContainer } from "awilix";
import type { Cradle } from "@fastify/awilix";
import { buildApp } from "#features/users/http/routes";
import { parseEnv } from "#shared/config/env";

const ACTOR = "sub-abc";

function page(overrides?: Record<string, unknown>) {
  return {
    items: [
      {
        id: "ntf_1",
        userId: "usr_alice",
        type: "ORDER_STATUS",
        title: "Your order has shipped",
        body: "ORD-3MRAI-10482 · Handed to the carrier and on its way to you.",
        metadata: { status: "SHIPPED", order_id: "ord_1", occurred_at: "2026-08-01T17:48:03" },
        readAt: null,
        createdAt: new Date("2026-08-01T17:48:03Z"),
      },
    ],
    unread_count: 3,
    window_total: 7,
    window_days: 90,
    ...overrides,
  };
}

// An isolated container, so buildApp registers nothing real — the pattern the
// existing route tests use.
function container(stubs: Record<string, unknown>): AwilixContainer<Cradle> {
  const c = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY });
  c.register({
    env: asValue(parseEnv({ ...process.env })),
    db: asValue({} as never),
    metricsPublisher: asValue({ publish: () => undefined } as never),
    ...Object.fromEntries(Object.entries(stubs).map(([key, value]) => [key, asValue(value)])),
  } as never);
  return c;
}

describe("GET /v1/notifications", () => {
  let calls: Array<string>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    calls = [];
    app = buildApp(
      container({
        notificationQueryService: {
          list: async (_user: unknown, filter: string) => {
            calls.push(filter);
            return page();
          },
          unreadCount: async () => 3,
        },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 3 }) },
      }),
    );
  });

  it("returns the page for an authenticated caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications",
      headers: { "x-user-id": ACTOR },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ unread_count: 3, window_total: 7, window_days: 90 });
    expect(body.items[0]).toMatchObject({
      id: "ntf_1",
      type: "ORDER_STATUS",
      title: "Your order has shipped",
      read_at: null,
    });
    // The wire shape is snake_case and carries an ISO string, not a Date.
    expect(typeof body.items[0].created_at).toBe("string");
  });

  it("defaults the filter to all", async () => {
    await app.inject({ method: "GET", url: "/v1/notifications", headers: { "x-user-id": ACTOR } });
    expect(calls).toEqual(["all"]);
  });

  it.each(["all", "unread", "read"])("accepts filter=%s", async (filter) => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/notifications?filter=${filter}`,
      headers: { "x-user-id": ACTOR },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toContain(filter);
  });

  it("rejects an unknown filter with 400", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications?filter=archived",
      headers: { "x-user-id": ACTOR },
    });
    expect(response.statusCode).toBe(400);
  });

  // CONTRACT: absent from public-routes.ts, which is what makes this 401.
  it("401s without an identity", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/notifications" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("GET /v1/notifications/unread-count", () => {
  it("returns just the count", async () => {
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => 12 },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 12 }) },
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/v1/notifications/unread-count",
      headers: { "x-user-id": ACTOR },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unread_count: 12 });
  });

  it("401s without an identity", async () => {
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => 0 },
        markNotificationsReadCommand: { execute: async () => ({ updated: 0, unread_count: 0 }) },
      }),
    );
    const response = await app.inject({ method: "GET", url: "/v1/notifications/unread-count" });
    expect(response.statusCode).toBe(401);
  });
});

describe("PATCH /v1/notifications/read", () => {
  function appWith(updated: number, unread = 1) {
    const seen: string[][] = [];
    const app = buildApp(
      container({
        notificationQueryService: { list: async () => page(), unreadCount: async () => unread },
        markNotificationsReadCommand: {
          execute: async (_user: unknown, ids: string[]) => {
            seen.push(ids);
            return { updated, unread_count: unread };
          },
        },
      }),
    );
    return { app, seen };
  }

  it("marks a list of ids read", async () => {
    const { app, seen } = appWith(2);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_1", "ntf_2"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ updated: 2, unread_count: 1 });
    expect(seen[0]).toEqual(["ntf_1", "ntf_2"]);
  });

  // CONTRACT: 200 with updated: 0, NOT 400 — arriving with nothing unread is the
  // normal case for mark-on-enter.
  it("answers 200 for an empty id list", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: 0 });
  });

  // CONTRACT: A single-id PATCH affecting 0 rows returns 404, indistinguishable
  // from "does not exist" — deliberately, so it cannot be used to probe for
  // another user's notifications.
  it("404s when a single id matched nothing", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_someone_elses"] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });

  it("does NOT 404 when a multi-id PATCH matched nothing", async () => {
    // Several ids are a bulk operation; some already being read is routine.
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: ["ntf_1", "ntf_2"] },
    });

    expect(response.statusCode).toBe(200);
  });

  it("rejects more than 50 ids with 400", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      headers: { "x-user-id": ACTOR },
      payload: { ids: Array.from({ length: 51 }, (_, i) => `ntf_${i}`) },
    });

    expect(response.statusCode).toBe(400);
  });

  it("401s without an identity", async () => {
    const { app } = appWith(0);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/notifications/read",
      payload: { ids: ["ntf_1"] },
    });
    expect(response.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test -- features/notifications/routes
```
Expected: FAIL — 404 for every route, because none is registered yet.

- [ ] **Step 3: Write the schemas**

Create `services/users/src/features/notifications/http/schemas.ts`:
```ts
import { z } from "zod/v4";
import { NOTIFICATIONS_LIMIT, WINDOW_DAYS } from "../queries/list-notifications.ts";

/**
 * CONTRACT: The wire shape is snake_case, unlike the domain type's camelCase. The
 * web binds to these names, so renaming one is a breaking API change.
 */
export const NotificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  // Passthrough: `metadata` is a deliberately open bag whose keys vary by variant
  // (a WELCOME row has no status and no order_id), and pinning it here would reject
  // a new variant's key before the web could read it.
  metadata: z.record(z.string(), z.unknown()),
  read_at: z.string().nullable(),
  created_at: z.string(),
});

export const NotificationsPageSchema = z.object({
  items: z.array(NotificationSchema),
  // Separate from `items.length` on purpose: the count pill must stay exact when
  // the 50 cap truncates the list.
  unread_count: z.number().int().nonnegative(),
  // A 90-day count WITHOUT the cap, so it can exceed items.length.
  window_total: z.number().int().nonnegative(),
  window_days: z.literal(WINDOW_DAYS),
});

export const UnreadCountSchema = z.object({
  unread_count: z.number().int().nonnegative(),
});

/** `filter` defaults to `all`; anything outside the three values is a 400. */
export const NotificationFilterQuerySchema = z.object({
  filter: z.enum(["all", "unread", "read"]).default("all"),
});

/**
 * CONTRACT: A LIST of ids, and capped at the same 50 as the list. An empty array
 * is VALID and answers 200 with `updated: 0` — arriving with nothing unread is the
 * normal case for the All screen's mark-on-enter.
 */
export const MarkReadInputSchema = z.object({
  ids: z.array(z.string().min(1)).max(NOTIFICATIONS_LIMIT),
});

export const MarkReadResultSchema = z.object({
  updated: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
});
```

- [ ] **Step 4: Register the two use cases**

In `services/users/src/shared/di/awilix-container.ts`, add the imports:
```ts
import { NotificationQueryService } from "#features/notifications/queries/list-notifications";
import { MarkNotificationsReadCommand } from "#features/notifications/commands/mark-notifications-read";
```
Add to `Cradle`:
```ts
    notificationQueryService: NotificationQueryService;
    markNotificationsReadCommand: MarkNotificationsReadCommand;
```
Add to `registerServices()`:
```ts
    notificationQueryService: asClass(NotificationQueryService, { lifetime: Lifetime.SCOPED }),
    markNotificationsReadCommand: asClass(MarkNotificationsReadCommand, {
      lifetime: Lifetime.SCOPED,
    }),
```

- [ ] **Step 5: Register the three routes**

In `services/users/src/features/users/http/routes.ts`, add the imports beside the existing schema
import:
```ts
import {
  NotificationsPageSchema, UnreadCountSchema,
  MarkReadInputSchema, MarkReadResultSchema, NotificationFilterQuerySchema,
} from "#features/notifications/http/schemas";
import type { Notification } from "#features/notifications/domain/notification";
```
Add the serializer beside `serializeUser`:
```ts
// `Notification` carries real `Date` fields; the wire shape is snake_case with ISO
// strings. Convert at the HTTP boundary — Zod's serializer strictly REJECTS a Date
// against z.string(), it does not coerce.
export function serializeNotification(notification: Notification) {
  return {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    body: notification.body,
    metadata: notification.metadata,
    read_at: notification.readAt ? notification.readAt.toISOString() : null,
    created_at: notification.createdAt.toISOString(),
  };
}
```
Add a `tags` entry to the Swagger config's `tags` array:
```ts
        { name: "notifications", description: "In-app notification inbox" },
```
Then add the three routes inside the existing `app.after()` callback, after the
`PATCH /v1/users/me/password` route:
```ts
    // CONTRACT: `user_id` comes from the JWT via the x-user-id header, NEVER from a
    // parameter or body — a caller-supplied id would read anyone's inbox. Do NOT
    // add any of these three to `shared/http/public-routes.ts`: that absence is
    // what makes the onRequest hook 401 a request with no identity.
    // See [[2026-09-10-in-app-notifications-design]]
    r.get("/v1/notifications", {
      schema: {
        tags: ["notifications"], operationId: "listNotifications",
        summary: "List the caller's newest notifications",
        description:
          "Returns the newest 50 by created_at desc with NO date bound, plus an exact "
          + "unread_count and a 90-day window_total that may exceed items.length. "
          + "Deliberately unpaginated.",
        headers: UserIdHeader,
        querystring: NotificationFilterQuerySchema,
        response: { 200: NotificationsPageSchema },
      },
    }, async (req, reply) => {
      const { notificationQueryService, currentUser } = req.diScope.cradle;
      const page = await notificationQueryService.list(currentUser, req.query.filter);
      return reply.send({
        items: page.items.map(serializeNotification),
        unread_count: page.unread_count,
        window_total: page.window_total,
        window_days: page.window_days,
      });
    });

    // Separate from the list so the bell badge costs one COUNT rather than a full
    // page fetch — the panel polls this, the list is read on open.
    r.get("/v1/notifications/unread-count", {
      schema: {
        tags: ["notifications"], operationId: "getUnreadNotificationCount",
        summary: "Count the caller's unread notifications",
        headers: UserIdHeader,
        response: { 200: UnreadCountSchema },
      },
    }, async (req, reply) => {
      const { notificationQueryService, currentUser } = req.diScope.cradle;
      return reply.send({ unread_count: await notificationQueryService.unreadCount(currentUser) });
    });

    // CONTRACT: A LIST of ids, which is why there is no separate read-all route —
    // one endpoint covers entering the All screen, "Mark all as read", and marking
    // a single one. An empty list answers 200 with updated: 0, never 400.
    r.patch("/v1/notifications/read", {
      schema: {
        tags: ["notifications"], operationId: "markNotificationsRead",
        summary: "Mark the caller's notifications read",
        description:
          "Idempotent: only rows with read_at IS NULL are updated, which matters because "
          + "the client's mark-on-enter can fire twice on a remount. A SINGLE id matching "
          + "no row answers 404, indistinguishable from \"does not exist\", so it cannot "
          + "probe for another user's notifications.",
        headers: UserIdHeader,
        body: MarkReadInputSchema,
        response: { 200: MarkReadResultSchema, 404: ErrorSchema },
      },
    }, async (req, reply) => {
      const { markNotificationsReadCommand, currentUser } = req.diScope.cradle;
      const { ids } = req.body;
      const result = await markNotificationsReadCommand.execute(currentUser, ids);

      // Only the SINGLE-id case 404s. Several ids are a bulk operation where some
      // already being read is routine, so a zero there is a normal 200.
      if (ids.length === 1 && result.updated === 0) {
        return reply.code(404).send({ error: "not_found" });
      }
      return reply.send(result);
    });
```

- [ ] **Step 6: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users test && pnpm --filter users build && pnpm --filter users lint
```
Expected: all tests pass (14 new), clean build and lint.

- [ ] **Step 7: Regenerate the OpenAPI spec**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter users generate:openapi
grep -n 'notifications' services/users/openapi.yaml | head -20
```
Expected: the three paths and their operation ids appear. `e2e-impl` verifies contracts against
this file rather than guessing them, so a stale spec sends the E2E work down the wrong path.

- [ ] **Step 8: Confirm the comment gate passes**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make lint-comments-diff
```
Expected: no NEW violations. The gate is a ratchet, so it fails only on comments this work
introduced — a >12-line block or a past-tense sentence about this codebase.

- [ ] **Step 9: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(users): expose the three notification endpoints

GET /v1/notifications (filter=all|unread|read, newest 50, unpaginated),
GET /v1/notifications/unread-count, and PATCH /v1/notifications/read taking a list
of ids. All three take user_id from the JWT and are absent from public-routes.ts, so
a request with no identity 401s. A single-id PATCH matching nothing answers 404 so it
cannot probe for another user's notifications.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 3.9: Internal E2E — the endpoints on the service port

**Owner: the `e2e-impl` agent.** It reads `e2e/CLAUDE.md`, verifies the contract against
`services/users/openapi.yaml` rather than guessing it, and **never edits service source to make a
test pass**.

**Files:**
- Create: `e2e/tests/notifications.spec.ts`

**Interfaces:**
- Consumes: the three routes from Task 3.8 on Users' direct port (`http://localhost:3000`), and
  the existing internal-spec helpers in `e2e/support/`.
- Produces: layer 2 of the three required layers. This is the layer quietly skipped because the
  gateway spec feels like it covers the same ground — it does not: the gateway spec is slower and
  must not carry the exhaustive cases, which live here.

- [ ] **Step 1: Write the internal spec**

It talks to Users directly, so it sets `x-user-id` itself rather than carrying a JWT — that is
what makes it fast enough to hold the exhaustive cases.

Create `e2e/tests/notifications.spec.ts` covering:
- **Setup**: register a user through Users directly with `x-e2e-source: true` so global teardown
  sweeps the row, then read its `usr_` id from the response.
- `GET /v1/notifications` with no notifications yet → 200,
  `{ items: [], unread_count: 0, window_total: 0, window_days: 90 }`.
- Seed rows by publishing to the SNS topic (the real path) and polling the list until they appear,
  **asserting on the titles that arrived, never only the count** — a "got 1 of 2" cannot tell a
  broken consumer from a wrong expectation. Seed **all three** producing types, since all three are
  admitted by the filter policy: a `USER_CREATED` (→ "Welcome to 3MRAI!"), an `ORDER_CREATED` (→
  "Order placed", `metadata.status === "PLACED"`), and a `TRACKING_STATUS_CHANGED` carrying
  `SHIPPED` (→ "Your order has shipped"). Publish the `ORDER_CREATED` envelope with the payload
  `OrderCreatedPayloadSchema` declares (`functions/events-pipeline/src/handlers/order-created.ts`):
  `order_id`, `user_id`, `created_at` and an optional `order_number`, plus the money fields and
  items array it requires.
- **One `ORDER_CREATED` with `order_number` omitted** → the body is the bare sentence, with no
  stray separator and no literal `undefined`.
- An `AUTH_OTP_REQUESTED` published to the topic produces **no** row — the filter policy keeps it
  off the queue, and the consumer would discard it anyway.
- `filter=unread` / `filter=read` / `filter=all` each return the expected **titles**.
- `filter=archived` → 400.
- `GET /v1/notifications/unread-count` agrees with the list's `unread_count`.
- `PATCH /v1/notifications/read` with two ids → `{ updated: 2 }`, then the same call again →
  `{ updated: 0 }` (idempotent), and `unread_count` drops by two.
- `PATCH` with `ids: []` → 200 `{ updated: 0 }`.
- `PATCH` with a single unknown id → 404.
- `PATCH` with 51 ids → 400.
- **Cross-user isolation**: a second user's `PATCH` naming the first user's ids reports
  `updated: 0`, and the first user's rows stay unread.
- No `x-user-id` → 401 on all three.

- [ ] **Step 2: Run it and confirm green**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/e2e test -- notifications.spec.ts
```
Expected: green. Needs the stack up (`make bootstrap`).

- [ ] **Step 3: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
test(e2e): internal E2E for the notification endpoints

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.10: Gateway E2E — the URL the user actually hits, plus the socket

**Owner: the `e2e-impl` agent.**

**Files:**
- Create: `e2e/tests/gateway/notifications.spec.ts`

**Interfaces:**
- Consumes: `getGatewayToken()` from `e2e/support/auth.ts`; `gatewayClient(token)` from
  `e2e/support/gateway-client.ts` (paths are **relative, no leading slash**);
  `openSocket(wsUrl, token)` / `tryOpen(wsUrl, token)` from `e2e/support/ws-client.ts`;
  `pickProductWithStock(catalogue)` from `e2e/support/catalogue.ts`; `process.env.WS_URL` and
  `process.env.API_GATEWAY_URL`.
- Produces: layer 3 — the only layer exercising the whole chain, including the API Gateway route
  map and the authorizer. Nothing here is faked.

- [ ] **Step 1: Write the gateway spec**

Create `e2e/tests/gateway/notifications.spec.ts` covering:

**A. The routes resolve and are guarded.**
- `test.skip(!WS_URL, ...)` for the socket tests, following `realtime-tracking.spec.ts`.
- Each of the three routes **without** a token → **401**, not 404. A 404 carrying the gateway's own
  `{"message":"Not Found"}` means the request never reached the service, i.e. the route is missing
  from the map — assert on the **body shape**, so the two are distinguishable.
- Each route **with** a real Cognito JWT → 200.

**B. The welcome notification arrives end to end.**
- Register a user through the gateway (`getGatewayToken()`), then poll
  `GET v1/notifications` until the `WELCOME` row appears (Cognito → Users → SNS → queue → consumer
  is not instantaneous; budget ~60s, as the tracking specs do).
- Assert `title === "Welcome to 3MRAI!"` and `type === "WELCOME"`, and that `metadata` carries no
  `order_id`. **Print the received titles on timeout**, never a bare count.

**C. `NOTIFICATION_CREATED` is delivered over the socket.**
- Open a socket with `openSocket(WS_URL, token)`, then create a TestMode order
  (`x-test-mode: true`) as `realtime-tracking.spec.ts` does, which drives the four-transition
  progression.
- `test.setTimeout(180_000)`; wait for messages and then **filter by `type`** — two message types
  now share this socket (`TRACKING_STATUS_CHANGED` from the pipeline and `NOTIFICATION_CREATED`
  from Users), and the pipeline's existing push is deliberately untouched.
- **CONTRACT to encode in a comment — TWO DIFFERENT COUNTS OVER TWO DIFFERENT MESSAGE TYPES, and
  neither is a typo for the other:**
  - **FIVE `NOTIFICATION_CREATED` frames** for one full order lifecycle: one from `ORDER_CREATED`
    (the `PLACED` variant) plus one per tracking transition (`PROCESSING`, `SHIPPED`,
    `OUT_FOR_DELIVERY`, `DELIVERED`).
  - **FOUR `TRACKING_STATUS_CHANGED` frames**, which is what the pre-existing
    `e2e/tests/gateway/realtime-tracking.spec.ts` asserts and continues to assert — `PLACED` is the
    state a tracking row is created in, not a transition, and no producer emits it
    (`services/tracking-go/internal/app/create_tracking.go` says so explicitly). **Tracking is not
    modified by this work.**

  Spell both out in the comment. The two numbers differ because the `PLACED` notification is
  produced by `ORDER_CREATED`, not by Tracking — so "fixing" one count to match the other breaks a
  working system. Asking for four `NOTIFICATION_CREATED` frames fails with an extra message that
  reads like a duplicate; asking for five `TRACKING_STATUS_CHANGED` frames fails with "got 4 of 5",
  which reads exactly like a dropped push.
- Assert the **set** of `notification.metadata.status` values equals
  `["DELIVERED", "OUT_FOR_DELIVERY", "PLACED", "PROCESSING", "SHIPPED"]` sorted — never the
  sequence, since records have no cross-record ordering guarantee, and `PLACED` in particular
  arrives from a different producer than the other four.
- On timeout or mismatch, **print the statuses and titles that arrived**, never a bare count — a
  "got 4 of 5" cannot separate a missing `ORDER_CREATED` subscription from a dropped tracking push.
- Assert each message carries a monotonically sensible `unread_count` and a non-empty
  `notification.title`.

**D. Cross-user isolation on the socket.**
- Two users, two sockets; the order belongs to Alice. Bob's socket receives **zero** messages.
  This is the only test that actually exercises the `cognito_sub` scoping — a push keyed by
  `user_id` would query the GSI and silently reach nobody, which looks identical to a working
  feature from Alice's side alone.

**E. Mark-read through the gateway.**
- `PATCH v1/notifications/read` with the ids from the list → `{ updated: n }`, then
  `GET v1/notifications/unread-count` reflects the drop.

- [ ] **Step 2: Run it and confirm green**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/e2e test -- gateway/notifications.spec.ts
```
Expected: green. A 404 with `{"message":"Not Found"}` on any route sends you back to Task 1.4.

- [ ] **Step 3: Run all three layers together**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
make test-all
```
Expected: green across unit, internal E2E and gateway E2E. **E2E variance in this suite exceeds
small effects** — 4-15 failures have been observed on the same commit — so read a handful of
failures as flake unless they name the notification specs specifically.

- [ ] **Step 4: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
test(e2e): gateway E2E for notifications, including the WebSocket push

Covers the three routes with a real Cognito JWT, the welcome notification end to
end, five NOTIFICATION_CREATED frames for one order lifecycle (ORDER_CREATED gives
the PLACED one, the four tracking transitions give the rest) against the four
TRACKING_STATUS_CHANGED frames the pre-existing tracking spec still sees, and
cross-user socket isolation — the only test that exercises the cognito_sub scoping.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 3.11: Load-test scenario for the notification reads

**Owner: the `e2e-impl` agent.** Gatling JS — load the `gatling-js` skill before writing the file;
the DSL is easy to guess wrong and the Community Edition boundary easy to cross by accident.

**Files:**
- Create: `e2e/load-tests/simulations/notifications.gatling.ts`

**Interfaces:**
- Consumes: the three endpoints and the existing load-test auth/feeder helpers in
  `e2e/load-tests/`.
- Produces: a sustained-read scenario. It deliberately sends **neither** `x-e2e-source` **nor**
  `x-test-mode`, so its data persists like real data and deliveries advance only through the
  carrier webhook.

The route changes how users reach an existing flow (the bell polls `unread-count` on every page),
which is what makes a load scenario required rather than optional.

- [ ] **Step 1: Write the simulation**

Cover, per virtual user: sign in, then loop — `GET /v1/notifications/unread-count` (the frequent
one, as the bell badge polls it), `GET /v1/notifications` (on panel open), and
`PATCH /v1/notifications/read` with the ids just read. Note in a comment that a virtual user who
also places an order accrues **five** notifications over that order's lifecycle — the `PLACED` one
from `ORDER_CREATED` plus the four tracking transitions — so unread counts grow faster per order
than the tracking WebSocket's four frames would suggest. Assert on p95 latency and a zero error rate,
and note in a comment that `unread-count` is the highest-frequency call because the badge is on
every page.

- [ ] **Step 2: Typecheck and smoke-run it**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/e2e typecheck
cd e2e && pnpm exec gatling run --typescript --simulation notifications usersPerSec=2 duration=60
```
Expected: a clean typecheck and a 60-second run with no errors. **Measure across 2-3× any period
you care about** — a window equal to an export cycle has produced false PASSes here before.

- [ ] **Step 3: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
test(e2e): add the notifications load simulation

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### 🚦 GATE 3 — STOP HERE (dependency gate)

Phase 4 binds the web app to the three endpoints and the `NOTIFICATION_CREATED` frame, so those
must be merged and reachable first. **Batch Tasks 3.1-3.11 as one list of open PRs for the user to
review and merge, then stop.** Continue to Phase 4 only after they are merged.

---

## Phase 4 — Web: tokens, store, socket, components, All screen

**Precondition: GATE 3 passed** (the three endpoints are merged and reachable through the gateway).

**Owner: the `web-impl` agent** for every task in this phase. It reads `apps/web/CLAUDE.md` and
`apps/web/DESIGN.md`, and translates Pencil frames through the `pencil-design-extraction` skill.

**Important — these components already exist, fixture-backed.** `NotificationItem`,
`ToastNotification` and `NotificationsPanel` were built in the web-app foundation milestone against
`apps/web/src/app/fixtures/notifications.fixture.ts`. This phase **rewires them to a real store and
widens the type**; it does not create them from scratch. The fixture is deleted at the end.

**Token naming.** The spec's copy table uses the **`.pen`** names; `styles.css` **remaps** several of
them (`apps/web/DESIGN.md:42`). The mapping this phase needs:

| `.pen` name | `styles.css` variable | Tailwind utility |
|---|---|---|
| `brand-navy` | `--color-brand-navy` | `text-brand-navy` |
| `brand-orange-light` | `--color-brand-orange-light` | `bg-brand-orange-light` |
| `brand-orange-text` | `--color-brand-orange-text` | `text-brand-orange-text` |
| `text-secondary` | `--color-ink-secondary` | `text-ink-secondary` |
| `warn-bg` / `warn-text` | `--color-warn-bg` / `--color-warn-ink` | `bg-warn-bg` / `text-warn-ink` |
| `info-bg` / `info-blue` | `--color-info-bg` / `--color-info-blue` | `bg-info-bg` / `text-info-blue` |
| `success-bg` / `success-text` | `--color-success-bg` / `--color-success-ink` | `bg-success-bg` / `text-success-ink` |
| `bg-subtle` | `--color-surface-subtle` | `bg-surface-subtle` |
| `border-color` | `--color-line` | `border-line` |
| **`brand-navy-light`** | **`--color-brand-navy-light`** (Task 4.1) | `bg-brand-navy-light` |
| **`neutral-bg`** | **`--color-neutral-bg`** (Task 4.1) | `bg-neutral-bg` |

### Task 4.1: Close the two design-token gaps, upstream in the `.pen` first

**Files:**
- Modify: `assets/web-app/web-app.pen` (via the Pencil MCP `SetVariables` — **never** Read/Grep;
  the file is encrypted)
- Modify: `apps/web/src/styles.css` (the first `@theme` block, the generated one)
- Modify: `apps/web/DESIGN.md` (the token table and the remapping line)

**Interfaces:**
- Consumes: `GetVariables()` over the Pencil MCP.
- Produces: two Tailwind utilities every later task in this phase uses —
  `bg-brand-navy-light` (the WELCOME bubble tint) and `bg-neutral-bg` (the `PLACED` bubble tint).

**Per [[pencil-design-extraction]], these are reported and fixed UPSTREAM, never worked around.**
Substituting the nearest existing token, or writing a hex, is the detectable symptom of a skipped
token step.

- [ ] **Step 1: Confirm both gaps still exist**

Call `GetVariables()` over the Pencil MCP and confirm:
1. **`brand-navy-light` is absent** (`brand-navy`, `brand-navy-deep` and `brand-orange-light`
   exist; this one does not), while both welcome variants reference it.
2. **`PLACED` uses a hard-coded `#E5E7EB`** in all eleven variants — exactly the value of the
   existing `border-color` token, but not referenced as a variable.

Record the actual variable count returned; the spec observed 30.

- [ ] **Step 2: Add the two variables to the `.pen`**

Call `SetVariables` to add:
- `brand-navy-light` — the tint pairing with `brand-navy` as its icon colour, matching the
  relationship `brand-orange-light`/`brand-orange-text` already has. Use the value the welcome
  frames render.
- `neutral-bg` — `#E5E7EB`, the value `PLACED` currently hard-codes. **A named neutral, not a
  reuse of `border-color`**: a border colour and a bubble tint are different roles that happen to
  share a value today, and collapsing them means a future border change silently retints the
  `PLACED` bubble.

Then repoint `PLACED`'s bubble tint at `neutral-bg` and confirm both welcome variants resolve
`brand-navy-light`.

- [ ] **Step 3: Verify the `.pen` was actually SAVED**

**MCP quirk: `SetVariables` is in-memory until a human saves the file in the desktop app.**
Reporting the design change as done without this check is how a token that "exists" is missing on
the next machine.

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
git hash-object assets/web-app/web-app.pen
git rev-parse HEAD:assets/web-app/web-app.pen
```
Expected: **the two hashes DIFFER.** Identical hashes mean the edit is still in memory — ask the
user to save the `.pen` in the Pencil desktop app, then re-check. Do not proceed until they differ.

- [ ] **Step 4: Propagate the tokens into `styles.css`**

Add to the **first** `@theme` block (the one generated from the `.pen`), beside their siblings:
```css
  --color-brand-navy-light: #EEF1F6;
  --color-neutral-bg: #E5E7EB;
```
Place `--color-brand-navy-light` immediately after `--color-brand-navy-deep` in the Brand group,
and `--color-neutral-bg` in the Semantic group beside the other `*-bg` pairs. **Use the exact
values `GetVariables()` returned** — the placeholder above must be replaced with what the `.pen`
actually holds.

**CONTRACT: the `--color-*` prefix is mandatory.** Without it Tailwind generates no utility and
`bg-brand-navy-light` silently does not exist — the class is simply dropped, with no build error.

- [ ] **Step 5: Document them in `DESIGN.md`**

Add both to the token table, and extend the remapping line (line 42) with the two new entries:
`brand-navy-light` → `--color-brand-navy-light` → `bg-brand-navy-light`; `neutral-bg` →
`--color-neutral-bg` → `bg-neutral-bg`. Note that `neutral-bg` shares `border-color`'s value today
but is a distinct role, so the two are not collapsed.

- [ ] **Step 6: Prove the utilities compile**

A token that produces no utility fails silently, so compile a real usage rather than trusting the
CSS.

Temporarily add `<div class="bg-brand-navy-light bg-neutral-bg"></div>` to any template, then:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web build
grep -rE 'brand-navy-light|neutral-bg' apps/web/dist/**/*.css | head -5
```
Expected: both class names appear in the built CSS with their hex values. **An empty grep means the
utility does not exist** — check the `--color-` prefix. Remove the temporary div afterwards.

- [ ] **Step 7: Confirm no arbitrary colour values crept in**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
grep -rnE '(bg|text|border)-\[#' apps/web/src/ || echo "no arbitrary colour values"
```
Expected: `no arbitrary colour values`. A hex here is the detectable symptom of a skipped token
step.

- [ ] **Step 8: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Note that the `.pen` is a binary blob, so its diff is
opaque — the commit body carries what changed. Proposed message:

```
feat(web): add the brand-navy-light and neutral-bg design tokens

Both gaps are fixed UPSTREAM in the .pen and propagated to styles.css and
DESIGN.md, per pencil-design-extraction: brand-navy-light was referenced by both
welcome variants without existing, and PLACED hard-coded #E5E7EB in all eleven
variants. neutral-bg is a named role of its own rather than a reuse of
border-color, which shares its value today.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.2: Widen `AppNotification` and add the API client

**Files:**
- Modify: `apps/web/src/app/core/api/types.ts` (`AppNotification` at lines 265-272)
- Create: `apps/web/src/app/core/api/notifications-api.ts`
- Create: `apps/web/src/app/core/api/notifications-api.spec.ts`

**Interfaces:**
- Consumes: `ApiClient` from `../http/api-client` — its `get`/`patch` take a **service-relative**
  path with **no `/v1` prefix** (`APP_CONFIG.apiGatewayUrl` supplies it); `TrackingStatus` from
  `./types`; the response shapes from Task 3.8's schemas.
  **`TrackingStatus` here is the existing five-wide type** (`apps/web/src/app/core/api/types.ts:173`,
  `PLACED` included) and is **unchanged by this plan** — it is the right type for a stored
  `metadata.status`, which is five wide. The server's four-wide `TrackingEventStatus` (Task 3.2)
  describes what a `TRACKING_STATUS_CHANGED` event may carry and has **no web counterpart**: the
  web never parses that event. Do not narrow this type.
- Produces:
  - `AppNotification` widened to `{ id, type, title, body, metadata, readAt, createdAt }` —
    **`read: boolean` is replaced by `readAt: string | null`.**
  - `export type NotificationType = 'WELCOME' | 'ORDER_STATUS'`
  - `export interface NotificationMetadata { status?: TrackingStatus; order_id?: string; order_number?: string; occurred_at: string }`
  - `export interface NotificationsPage { items: AppNotification[]; unreadCount: number; windowTotal: number; windowDays: number }`
  - `export class NotificationsApi` with
    `list(filter: NotificationFilter): Observable<NotificationsPage>`,
    `unreadCount(): Observable<number>`,
    `markRead(ids: readonly string[]): Observable<MarkReadResult>`.
  - Task 4.3's store and Tasks 4.5-4.7's components consume these.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/core/api/notifications-api.spec.ts` covering:
- `list()` calls `GET /notifications` with `params: { filter }` — **no `/v1` prefix** (writing
  `/v1/notifications` yields `/v1/v1/notifications`, answered by the gateway's own 404).
- `list()` maps the snake_case wire shape to the camelCase view model:
  `unread_count`→`unreadCount`, `window_total`→`windowTotal`, `window_days`→`windowDays`,
  and each item's `read_at`→`readAt`, `created_at`→`createdAt`.
- An item with `read_at: null` maps to `readAt: null`, and a non-null one keeps its ISO string.
- `unreadCount()` calls `GET /notifications/unread-count` and unwraps `unread_count`.
- `markRead(['ntf_1'])` calls `PATCH /notifications/read` with body `{ ids: ['ntf_1'] }`.
- `markRead([])` still issues the request (the server answers 200 with `updated: 0`).

Use the `HttpTestingController` pattern the sibling `cart-api.spec.ts` already uses.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notifications-api
```
Expected: FAIL — `notifications-api` cannot be resolved.

- [ ] **Step 3: Widen the type**

In `apps/web/src/app/core/api/types.ts`, replace `AppNotification` (lines 265-272):
```ts
/** Drives the toast eyebrow and the CTA. A column on the server, not metadata. */
export type NotificationType = 'WELCOME' | 'ORDER_STATUS';

/**
 * What the server's `metadata` bag carries. Keys VARY by variant — a WELCOME row
 * has neither `status` nor `order_id` — so every one but `occurred_at` is optional.
 *
 * CONTRACT: This is what keeps presentation DERIVED rather than baked into the
 * text. Without `status` there is no icon and no tint; without `order_id` there is
 * no "View order" CTA.
 */
export interface NotificationMetadata {
  /**
   * The STORED status, five wide. `PLACED` is written by the ORDER_CREATED-driven
   * row, the other four by tracking transitions — the web treats all five alike.
   */
  status?: TrackingStatus;
  order_id?: string;
  /** The display form, e.g. `ORD-3MRAI-10482`. Absent for an order with none. */
  order_number?: string;
  occurred_at: string;
}

/**
 * One notification as the app renders it.
 *
 * CONTRACT: `readAt` is a timestamp, not an `isRead` boolean — it answers "when" as
 * well as "whether", and it governs TWO visual properties: the unread dot and the
 * row's `bg-surface-subtle` background.
 */
export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  metadata: NotificationMetadata;
  readAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 4: Write the API client**

Create `apps/web/src/app/core/api/notifications-api.ts`:
```ts
import { inject, Injectable } from '@angular/core';
import { Observable, map } from 'rxjs';

import { ApiClient } from '../http/api-client';
import { AppNotification, NotificationsPage } from './types';

/**
 * The notifications surface of services/users/openapi.yaml.
 *
 * CONTRACT: Paths carry NO "/v1" prefix — APP_CONFIG.apiGatewayUrl supplies it.
 * Writing "/v1/notifications" yields a request to "/v1/v1/notifications", answered
 * by the gateway's own 404 rather than by Users.
 */

export type NotificationFilter = 'all' | 'unread' | 'read';

export interface MarkReadResult {
  updated: number;
  unreadCount: number;
}

/** The server's snake_case wire shapes, converted at this boundary and nowhere else. */
interface NotificationWire {
  id: string;
  type: AppNotification['type'];
  title: string;
  body: string;
  metadata: AppNotification['metadata'];
  read_at: string | null;
  created_at: string;
}

interface PageWire {
  items: NotificationWire[];
  unread_count: number;
  window_total: number;
  window_days: number;
}

function toNotification(wire: NotificationWire): AppNotification {
  return {
    id: wire.id,
    type: wire.type,
    title: wire.title,
    body: wire.body,
    metadata: wire.metadata,
    readAt: wire.read_at,
    createdAt: wire.created_at,
  };
}

/** Exported so the socket client maps an inbound frame through the same function. */
export { toNotification };

@Injectable({ providedIn: 'root' })
export class NotificationsApi {
  private readonly api = inject(ApiClient);

  /**
   * GET /notifications — the newest 50, newest first.
   *
   * CONTRACT: Deliberately unpaginated, and `windowTotal` is a 90-day count WITHOUT
   * the cap, so it can exceed `items.length`. That is why the counters are separate:
   * the pill must stay exact when the cap truncates the list.
   */
  list(filter: NotificationFilter = 'all'): Observable<NotificationsPage> {
    return this.api.get<PageWire>('/notifications', { params: { filter } }).pipe(
      map((wire) => ({
        items: wire.items.map(toNotification),
        unreadCount: wire.unread_count,
        windowTotal: wire.window_total,
        windowDays: wire.window_days,
      })),
    );
  }

  /** GET /notifications/unread-count — the badge, without fetching a page. */
  unreadCount(): Observable<number> {
    return this.api
      .get<{ unread_count: number }>('/notifications/unread-count')
      .pipe(map((wire) => wire.unread_count));
  }

  /**
   * PATCH /notifications/read — one endpoint for all three cases: entering the All
   * screen, "Mark all as read", and marking a single one.
   *
   * CONTRACT: An EMPTY list is valid and answers 200 with `updated: 0` — arriving
   * with nothing unread is the normal case. The server only updates rows whose
   * `read_at` is null, so a repeated call is a no-op; that is what makes the
   * mark-on-enter safe against an Angular remount firing it twice.
   */
  markRead(ids: readonly string[]): Observable<MarkReadResult> {
    return this.api
      .patch<{ updated: number; unread_count: number }>('/notifications/read', { ids })
      .pipe(map((wire) => ({ updated: wire.updated, unreadCount: wire.unread_count })));
  }
}
```
Add `NotificationsPage` to `types.ts` beside the interfaces above:
```ts
/** One page of the inbox, with its two independent counters. */
export interface NotificationsPage {
  items: AppNotification[];
  unreadCount: number;
  /** A 90-day count without the list cap, so it MAY exceed items.length. */
  windowTotal: number;
  windowDays: number;
}
```

- [ ] **Step 5: Run the test and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notifications-api
```
Expected: PASS. `pnpm --filter @3mrai/web typecheck` will still fail — the existing components read
the removed `read` boolean, which Tasks 4.5-4.7 fix. That is expected at this point.

- [ ] **Step 6: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): widen AppNotification to the wire shape and add the API client

read: boolean becomes readAt: string | null, and the type gains `type` and
`metadata` — presentation is derived from those rather than parsed out of the text.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.3: Build the NgRx store with the arrival highlight

**Files:**
- Create: `apps/web/src/app/core/notifications/notifications-store.ts`
- Create: `apps/web/src/app/core/notifications/notifications-store.spec.ts`

**Interfaces:**
- Consumes: `NotificationsApi.list/unreadCount/markRead` (Task 4.2); `AppNotification`;
  `ApiError`; the `signalStore` patterns in `apps/web/src/app/core/cart/cart-store.ts`.
- Produces:
  - `export const NotificationsStore` (a root `signalStore`) exposing signals
    `items`, `unreadCount`, `windowTotal`, `loading`, `error`, `filter`;
    computed `visible` (filtered), `hasUnread`;
    and methods `load(filter?)`, `setFilter(filter)`, `markRead(ids)`, `markAllRead()`,
    `receive(notification, unreadCount)`, `enterAllScreen()`, `leaveAllScreen()`,
    `isHighlighted(id)`.
  - Tasks 4.5-4.7 bind to these.

**Approved decision 8 — the arrival highlight.** The frame shows three unread rows with active dots
**and** a "Mark all as read" button while on that screen, which literally contradicts "entering
marks everything read". The resolution: **send the PATCH on entering, but keep the highlight for the
duration of the visit.** The store remembers which ids arrived unread and keeps their dot and
`bg-surface-subtle` until the screen is left; on reload they render as read. This satisfies both the
frame and the instruction, and **costs the backend nothing** — the server has no notion of "read but
still highlighted".

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/core/notifications/notifications-store.spec.ts` covering:
- `load()` populates `items`, `unreadCount` and `windowTotal` from the API, and clears `loading`.
- A failing `load()` sets a human sentence in `error` and leaves `items` untouched.
- `setFilter('unread')` re-requests with that filter.
- **`enterAllScreen()` captures the currently-unread ids into the highlight set AND sends one
  PATCH with exactly those ids.**
- **`isHighlighted(id)` stays true for a captured id even after `readAt` is set locally** — that is
  the frame's dot surviving the visit.
- **`enterAllScreen()` called twice does not send a second PATCH for ids already captured** — the
  Angular-remount case; it is also idempotent server-side, so this is belt and braces.
- `leaveAllScreen()` empties the highlight set, so a re-entry renders them as read.
- `markAllRead()` sends every unread id and drops `unreadCount` to 0.
- `markRead(['ntf_1'])` sets that row's `readAt` locally and decrements `unreadCount`.
- `markRead([])` sends no request at all (nothing to mark).
- **`receive(notification, 7)` prepends the row, sets `unreadCount` to the server's 7 (not a local
  increment), and does not duplicate an id already present** — a redelivered duplicate arrives as a
  distinct id, but the same id arriving twice over a reconnect must not double the row.
- `visible` respects the active filter.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notifications-store
```
Expected: FAIL — the store module cannot be resolved.

- [ ] **Step 3: Write the store**

Create `apps/web/src/app/core/notifications/notifications-store.ts` following the `CartStore`
shape (`signalStore` + `withState`/`withComputed`/`withMethods`, `firstValueFrom` for the calls,
and a `messageFor` helper for the error sentence). The pieces that carry real decisions:

```ts
interface NotificationsState {
  items: readonly AppNotification[];
  unreadCount: number;
  /** A 90-day count without the cap, so it may exceed items.length. */
  windowTotal: number;
  filter: NotificationFilter;
  loading: boolean;
  error: string | null;
  /**
   * Ids that were unread when the All screen was entered.
   *
   * CONTRACT: This is the ARRIVAL HIGHLIGHT, and it is CLIENT-ONLY — the server has
   * no notion of "read but still highlighted". Entering the screen marks everything
   * read, and these ids keep their dot and `bg-surface-subtle` for the rest of the
   * visit, which is what reconciles the frame (three unread rows plus a "Mark all
   * as read" button) with the instruction to mark on enter. Cleared on leave, so a
   * reload renders them read.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  highlighted: readonly string[];
}
```
```ts
    /**
     * Marks everything currently unread as read, keeping those rows highlighted.
     *
     * CONTRACT: Idempotent against a double call. Angular can remount the screen,
     * and the guard here plus the server's `read_at IS NULL` clause both hold —
     * belt and braces, because either alone would still double-count in the UI.
     */
    async enterAllScreen(): Promise<void> {
      const unreadIds = store.items().filter((n) => n.readAt === null).map((n) => n.id);
      const alreadyHeld = new Set(store.highlighted());
      const fresh = unreadIds.filter((id) => !alreadyHeld.has(id));

      // Keep the highlight for every id held OR newly captured, then mark read.
      patchState(store, { highlighted: [...store.highlighted(), ...fresh] });
      if (fresh.length === 0) return;
      await this.markRead(fresh);
    },
```
```ts
    /**
     * Applies an inbound NOTIFICATION_CREATED frame.
     *
     * CONTRACT: Take `unreadCount` from the SERVER's value, never a local
     * increment — the frame carries it precisely so the badge cannot drift, and a
     * local +1 would double-count a reconnect that replays a frame.
     */
    receive(notification: AppNotification, unreadCount: number): void {
      const present = store.items().some((n) => n.id === notification.id);
      patchState(store, {
        items: present ? store.items() : [notification, ...store.items()],
        unreadCount,
      });
    },
```

- [ ] **Step 4: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notifications-store
```
Expected: PASS.

- [ ] **Step 5: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): add the notifications store with the arrival highlight

Entering the All screen sends the PATCH and keeps the arrived-unread rows
highlighted for the visit — client-only state, which is how the frame's three
unread rows and its "Mark all as read" button coexist with mark-on-enter. Inbound
frames take the server's unread_count rather than incrementing locally.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 4.4: Build the WebSocket client and the toast queue

**Files:**
- Create: `apps/web/src/app/core/notifications/notifications-socket.ts`
- Create: `apps/web/src/app/core/notifications/toast-queue.ts`
- Create: `apps/web/src/app/core/notifications/toast-queue.spec.ts`

**Interfaces:**
- Consumes: `NotificationsStore.receive(notification, unreadCount)` (Task 4.3);
  `toNotification(wire)` (Task 4.2); the auth store's id token; `APP_CONFIG` for the WS URL.
- Produces:
  - `export class NotificationsSocket` with `connect(): void`, `disconnect(): void`, and a
    `status` signal (`'idle' | 'connecting' | 'open' | 'closed'`).
  - `export const TOAST_DISMISS_MS = 7000` — **the single constant** driving both the timer and
    the progress bar.
  - `export class ToastQueue` with `enqueue(notification)`, `dismiss(id)`, `pause()`, `resume()`,
    and a `current` signal.
  - Task 4.6's `ToastNotification` host binds to these.

**`apps/web/src` has ZERO WebSocket code today** — no `wss://`, no `websocket` references. This is
new.

**Approved decision 10 — 7 seconds, pausable.** These notifications carry a 3-5 word title and a
10-14 word body, roughly 4 seconds of reading, plus the time to notice something appeared in a
corner. Accessibility guidance puts the floor around 5 seconds and common toast guidance for a
message carrying an action is 4-10 seconds; **7 sits inside that band with margin.** Three rules
make the intent hold in the non-ideal cases: the timer **pauses on hover and on focus-within**; a
toast reached by **keyboard navigation does not auto-dismiss** while it holds focus; and toasts
**queue rather than stacking without bound.**

- [ ] **Step 1: Write the failing toast-queue test**

Create `apps/web/src/app/core/notifications/toast-queue.spec.ts` covering, with fake timers:
- A toast auto-dismisses after exactly `TOAST_DISMISS_MS`, and **not** at `TOAST_DISMISS_MS - 1`.
- `pause()` stops the countdown: advancing well past the window leaves it visible.
- `resume()` restarts it and it dismisses after the **remaining** time, not a fresh 7s.
- `dismiss(id)` removes it immediately and **does not mark the notification read** — dismissing a
  toast is not reading the notification, and the unread dot survives in the panel.
- Enqueuing three shows one at a time and the queue is **bounded** — several status transitions in
  a row cannot cover the screen.
- The next toast appears only after the current one leaves.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- toast-queue
```
Expected: FAIL — the module cannot be resolved.

- [ ] **Step 3: Write the toast queue**

Create `apps/web/src/app/core/notifications/toast-queue.ts`:
```ts
/**
 * CONTRACT: ONE constant for the dismiss timer AND the progress bar's animation
 * duration. Two independent values drift, and the bar then lies about how long is
 * left — the bar IS the visible timer, which is the whole reason it exists.
 *
 * WHY 7000: the copy is a 3-5 word title plus a 10-14 word body, about 4 seconds of
 * reading, plus the time to notice something appeared in a corner. Accessibility
 * guidance floors auto-dismissal around 5s and toast guidance for a message
 * carrying an action spans 4-10s; 7s sits inside that band with margin.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const TOAST_DISMISS_MS = 7000;

/**
 * CONTRACT: A hard bound. Several status transitions in a row must not cover the
 * screen, so extra toasts wait their turn rather than stacking.
 */
const MAX_QUEUED = 3;
```
Implement `ToastQueue` as an injectable holding a `current` signal, a bounded pending array, and a
pause-aware timer that tracks **remaining** time (capture the elapsed on `pause()`, restart with
the remainder on `resume()`) rather than restarting the full window.

- [ ] **Step 4: Write the socket client**

Create `apps/web/src/app/core/notifications/notifications-socket.ts`:
```ts
/**
 * The app's only WebSocket. Two message types share it: TRACKING_STATUS_CHANGED
 * from the events-pipeline (live order-detail updates) and NOTIFICATION_CREATED
 * from Users. This client dispatches only the latter and ignores the rest, so the
 * pipeline's existing push stays untouched.
 *
 * CONTRACT: The token rides the QUERY STRING. A WebSocket handshake cannot carry an
 * Authorization header — the only headers reaching the authorizer are the
 * handshake's own.
 * See [[2026-08-05-realtime-tracking-events-websocket-design]]
 */
```
Implement:
- `connect()` opening `${APP_CONFIG.wsUrl}?token=${encodeURIComponent(idToken)}`.
- `onmessage`: `JSON.parse`, and dispatch **only** when `type === 'NOTIFICATION_CREATED'` —
  mapping through `toNotification` and calling
  `store.receive(notification, frame.unread_count)` then `toasts.enqueue(notification)`.
  A malformed frame is caught and ignored: a socket must not throw into the app.
- Reconnection with **exponential backoff and a cap** (1s → 2s → 4s → … → 30s), reset on a
  successful open. A tight reconnect loop against a rejected token is a self-inflicted DoS.
- `disconnect()` clearing any pending retry and closing cleanly, so a sign-out does not reconnect.
- No reconnect attempt when there is no token — an unauthenticated socket is denied at the
  handshake anyway.

- [ ] **Step 5: Run the tests and see them pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- toast-queue
```
Expected: PASS.

- [ ] **Step 6: Add the WS URL to the app config**

The web app needs the host-facing `ws_url` (`ws://localhost:4566/ws/...`), **not** the in-network
`ws_management_endpoint`. Add `NG_APP_WS_URL` to `apps/web/.env.example` and read it in
`APP_CONFIG`, then add `WS_URL` to the `.env.local.web` block of
`infra/environments/local/scripts/generate_env_files.py` from the already-read `ws_url` variable.

**Restart the dev server after changing any `NG_APP_*`** — they are inlined at build time, so a
browser reload re-serves the old bundle and looks like the flag being ignored.

- [ ] **Step 7: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): add the notifications WebSocket client and the toast queue

The app's first WebSocket code. Dispatches only NOTIFICATION_CREATED, ignoring the
pipeline's TRACKING_STATUS_CHANGED frames that share the socket; reconnects with
capped exponential backoff. One TOAST_DISMISS_MS constant drives both the 7s timer
and the progress bar, so the bar cannot lie about the time left.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.5: Rewire `NotificationItem` to the real shape

**Files:**
- Modify: `apps/web/src/app/shared/ui/notification-item.ts`
- Modify: `apps/web/src/app/shared/ui/notification-item.html`
- Create: `apps/web/src/app/shared/ui/notification-icon-map.ts`
- Create: `apps/web/src/app/shared/ui/notification-item.spec.ts`

**Interfaces:**
- Consumes: `AppNotification` with `readAt`/`type`/`metadata` (Task 4.2);
  `NotificationsStore.isHighlighted(id)` (Task 4.3); `formatShortDateTime` from
  `../date/format-date`; `LucideDynamicIcon`.
- Produces:
  - `notification-icon-map.ts`: `export interface NotificationVisual { icon: string; bubble: string; iconColor: string }` and
    `export function visualFor(notification: AppNotification): NotificationVisual`.
  - `NotificationItem` gains `readonly highlighted = input(false)`.

**The eleven variants' visuals**, using the `styles.css` names from this phase's mapping table:

| type / status | icon | bubble tint | icon colour |
|---|---|---|---|
| `WELCOME` | `party-popper` | `bg-brand-navy-light` | `text-brand-navy` |
| `PLACED` | `receipt-text` | `bg-neutral-bg` | `text-ink-secondary` |
| `PROCESSING` | `package` | `bg-warn-bg` | `text-warn-ink` |
| `SHIPPED` | `warehouse` | `bg-info-bg` | `text-info-blue` |
| `OUT_FOR_DELIVERY` | `truck` | `bg-brand-orange-light` | `text-brand-orange-text` |
| `DELIVERED` | `package-check` | `bg-success-bg` | `text-success-ink` |

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/shared/ui/notification-item.spec.ts` covering:
- All six rows of the table above render the named icon, bubble and icon-colour classes —
  including `PLACED`, which is reached through `metadata.status`, exactly like the four
  tracking-written ones. The web never sees the triggering event type.
- **A row with `readAt: null` shows the unread dot and `bg-surface-subtle`**; a row with a
  non-null `readAt` shows neither (the frame's read rows are transparent).
- **`highlighted: true` keeps the dot and the background even when `readAt` is non-null** — the
  arrival highlight from decision 8.
- A notification whose `metadata.status` is absent (a `WELCOME`) still renders, falling back to the
  `party-popper` glyph rather than crashing.
- An unknown status falls back to a plain `bell` glyph and neutral tint rather than rendering an
  empty bubble.
- The timestamp renders through `formatShortDateTime`.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notification-item
```
Expected: FAIL — the component still reads the removed `read` boolean, and
`notification-icon-map` does not exist.

- [ ] **Step 3: Write the visual map**

Create `apps/web/src/app/shared/ui/notification-icon-map.ts`:
```ts
import type { AppNotification } from '../../core/api/types';

/**
 * CONTRACT: Presentation is driven by TWO axes, deliberately not flattened into one
 * enum: `type` decides the toast eyebrow and the CTA, `status` decides the icon and
 * the tint. Flattening them would need a variant per combination and would make
 * "an ORDER_STATUS with no status yet" unrepresentable.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export interface NotificationVisual {
  /** A lucide icon name, passed to LucideDynamicIcon. */
  icon: string;
  /** The bubble tint utility. */
  bubble: string;
  /** The glyph colour utility. */
  iconColor: string;
}

/**
 * CONTRACT: Every value here is a NAMED token utility. A hard-coded hex is the
 * detectable symptom of a skipped token step, and `bg-brand-navy-light` /
 * `bg-neutral-bg` exist only because they were added to the .pen first.
 * See [[pencil-design-extraction]]
 */
// Keyed by the STORED metadata.status, five wide. Which producer wrote a row is
// not a presentation concern: a PLACED row (written from ORDER_CREATED) renders
// exactly like the four written from tracking transitions.
const BY_STATUS: Readonly<Record<string, NotificationVisual>> = {
  PLACED: { icon: 'receipt-text', bubble: 'bg-neutral-bg', iconColor: 'text-ink-secondary' },
  PROCESSING: { icon: 'package', bubble: 'bg-warn-bg', iconColor: 'text-warn-ink' },
  SHIPPED: { icon: 'warehouse', bubble: 'bg-info-bg', iconColor: 'text-info-blue' },
  OUT_FOR_DELIVERY: {
    icon: 'truck',
    bubble: 'bg-brand-orange-light',
    iconColor: 'text-brand-orange-text',
  },
  DELIVERED: { icon: 'package-check', bubble: 'bg-success-bg', iconColor: 'text-success-ink' },
};

const WELCOME: NotificationVisual = {
  icon: 'party-popper',
  bubble: 'bg-brand-navy-light',
  iconColor: 'text-brand-navy',
};

/**
 * The fallback for a status this build does not know. A future variant reaches the
 * client before the client is redeployed, and an unrecognised status must render as
 * a plain notification rather than an empty bubble.
 */
const FALLBACK: NotificationVisual = {
  icon: 'bell',
  bubble: 'bg-neutral-bg',
  iconColor: 'text-ink-secondary',
};

export function visualFor(notification: AppNotification): NotificationVisual {
  if (notification.type === 'WELCOME') return WELCOME;
  const status = notification.metadata.status;
  return (status && BY_STATUS[status]) || FALLBACK;
}
```

- [ ] **Step 4: Rewire the component**

In `notification-item.ts`, add the `highlighted` input and the computed visual, and replace the
`read` reads:
```ts
export class NotificationItem {
  readonly notification = input.required<AppNotification>();

  /**
   * CONTRACT: Keeps the unread dot and background while the All screen is visited,
   * even once `readAt` is set — the arrival highlight from the design's decision 8.
   * Client-only: the server has no notion of "read but still highlighted".
   */
  readonly highlighted = input(false);

  protected readonly visual = computed(() => visualFor(this.notification()));

  /** Unread OR still highlighted: `readAt` governs two visual properties, not one. */
  protected readonly showsUnread = computed(
    () => this.notification().readAt === null || this.highlighted(),
  );

  protected readonly timeLabel = computed(() => formatShortDateTime(this.notification().createdAt));
}
```
In `notification-item.html`, bind the bubble and glyph to `visual()` and the row background/dot to
`showsUnread()`. Keep `templateUrl` (never an inline template), `rem` units (except borders), and
`ChangeDetectionStrategy.OnPush`.

- [ ] **Step 5: Run the test and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notification-item
```
Expected: PASS.

- [ ] **Step 6: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): drive NotificationItem from readAt, type and metadata

Two presentation axes rather than one enum: `type` picks the welcome variant,
`metadata.status` picks the icon and tint. An unknown status falls back to a bell
glyph so a new server variant renders rather than breaking.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.6: Rewire `ToastNotification` with its eyebrow, CTA and progress bar

**Files:**
- Modify: `apps/web/src/app/shared/ui/toast-notification.ts`
- Modify: `apps/web/src/app/shared/ui/toast-notification.html`
- Create: `apps/web/src/app/shared/ui/toast-notification.spec.ts`

**Interfaces:**
- Consumes: `AppNotification`; `visualFor` (Task 4.5); `TOAST_DISMISS_MS` (Task 4.4).
- Produces: `ToastNotification` keeps `notification` input and `dismissed`/`viewOrder` outputs,
  and gains `paused = output<boolean>()`. It still owns **no** visibility or timer state — the host
  (`ToastQueue`) owns that, which is what keeps a toast from closing the cart.

**Toast copy per decision 8's table:** eyebrow `ORDER UPDATE` for tracking and `WELCOME` for
welcome; CTA "View order" for tracking and "View my profile" for welcome (welcome has no
`order_id`, consistent with the envelope where `order_id` is null for `USER_CREATED`).

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/app/shared/ui/toast-notification.spec.ts` covering:
- An `ORDER_STATUS` toast renders the eyebrow `ORDER UPDATE` and the CTA "View order".
- A `WELCOME` toast renders the eyebrow `WELCOME` and the CTA "View my profile".
- The progress bar's animation duration equals `TOAST_DISMISS_MS` — **read from the constant, not a
  literal `7000`**, so a changed constant cannot leave the bar lying.
- `mouseenter` emits `paused(true)` and `mouseleave` emits `paused(false)`.
- `focusin` emits `paused(true)` — the accessible form of the same rule, so a toast reached by
  keyboard does not vanish while it holds focus.
- Clicking the close button emits `dismissed` and **not** any read-marking output: dismissing a
  toast is not reading the notification, and the unread dot survives in the panel.
- Clicking the CTA emits `viewOrder`.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- toast-notification
```
Expected: FAIL — no eyebrow, no CTA text and no `paused` output exist yet.

- [ ] **Step 3: Rewire the component**

Add to `toast-notification.ts`:
```ts
  /** Pauses/resumes the host's dismiss timer on hover and focus-within. */
  readonly paused = output<boolean>();

  /**
   * CONTRACT: The bar's duration comes from the SAME constant as the dismiss timer.
   * The bar IS the visible countdown, so two independent values would drift and the
   * bar would lie about how long is left.
   */
  protected readonly dismissMs = TOAST_DISMISS_MS;

  protected readonly visual = computed(() => visualFor(this.notification()));

  /** Eyebrow and CTA come from `type`; the icon and tint come from `status`. */
  protected readonly eyebrow = computed(() =>
    this.notification().type === 'WELCOME' ? 'WELCOME' : 'ORDER UPDATE',
  );
  protected readonly ctaLabel = computed(() =>
    this.notification().type === 'WELCOME' ? 'View my profile' : 'View order',
  );
```
In `toast-notification.html`, add the eyebrow, the CTA, and the progress fill with
`[style.animation-duration.ms]="dismissMs"`, plus `(mouseenter)`/`(mouseleave)`/`(focusin)`/
`(focusout)` emitting `paused`. Keep `templateUrl` and `OnPush`.

- [ ] **Step 4: Run the test and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- toast-notification
```
Expected: PASS.

- [ ] **Step 5: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): add the toast eyebrow, CTA and progress bar

The bar's animation duration is bound to TOAST_DISMISS_MS, the same constant the
host's timer uses, so the visible countdown cannot drift from the real one. Hover and
focus-within pause it; dismissing does not mark the notification read.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.7: Wire the panel and build the All screen (desktop + mobile)

**Files:**
- Modify: `apps/web/src/app/features/notifications/notifications-panel.ts` / `.html`
- Create: `apps/web/src/app/features/notifications/notifications-all.ts` / `.html`
- Create: `apps/web/src/app/features/notifications/notifications-all.spec.ts`
- Modify: `apps/web/src/app/app.routes.ts`
- Delete: `apps/web/src/app/fixtures/notifications.fixture.ts`
- Modify: `apps/web/src/app/core/layout/app-layout.ts` (mount the toast host, connect the socket)

**Interfaces:**
- Consumes: `NotificationsStore` (Task 4.3); `NotificationsSocket`, `ToastQueue` (Task 4.4);
  `NotificationItem` with its `highlighted` input (Task 4.5); `ToastNotification` (Task 4.6);
  `OverlayStore` (`toggleNotifications()`, `close()`, `active`); `Router`.
- Produces: the `notifications` route under the authed app layout, and a panel/All screen bound to
  real data. The fixture is gone.

**Frames:** `LWQ8g` Notifications Panel, `v7j7HT` All screen (desktop), `p6PjdF` Mobile —
Notifications All. Read them live over the Pencil MCP; the committed exports at
`apps/web/design/exports/notifications-{all,status-variants,welcome}.html` and
`mobile-notifications-all.html` are reference only.

- [ ] **Step 1: Write the failing All-screen test**

Create `apps/web/src/app/features/notifications/notifications-all.spec.ts` covering:
- **Three filter pills** (All / Unread / Read) with **All** as the default — note this differs from
  the panel, which uses two tabs (Unread / Read); both are served by `?filter=`.
- Clicking a pill calls `store.setFilter` with that value.
- **Date grouping TODAY / YESTERDAY / EARLIER**, with a different time format per group: relative
  ("12 min ago") or clock ("8:15 am") for recent, and full ("Aug 2 · 10:24 am") for EARLIER. Pure
  presentation derived from the timestamp — **no new server field**.
- **`enterAllScreen()` fires on init** (mark-on-enter), and `leaveAllScreen()` on destroy.
- A row that arrived unread keeps its dot for the visit (`highlighted` is passed through to
  `NotificationItem`).
- The subtitle renders "3 unread · 7 in the last 90 days" from `unreadCount` and `windowTotal` —
  which is what motivated the two separate counters.
- An empty list renders the empty state rather than a bare page.

- [ ] **Step 2: Run it and see it fail**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test -- notifications-all
```
Expected: FAIL — the component does not exist.

- [ ] **Step 3: Build the All screen**

Create `notifications-all.ts` / `.html` per the two frames. The load-bearing parts:
```ts
/**
 * Design: `Notifications — All` (`v7j7HT`) and `Mobile — Notifications All`
 * (`p6PjdF`). ONE component for both: the mobile frame differs only in layout, so a
 * second component would be two copies of the same list.
 *
 * CONTRACT: Three filter pills with All as default — deliberately different from
 * NotificationsPanel's two tabs (Unread / Read). Both are served by `?filter=`.
 */
```
```ts
  /**
   * CONTRACT: Mark-on-enter, with the arrival highlight preserved. The frame shows
   * unread rows AND a "Mark all as read" button while on this screen, which reads as
   * a contradiction; the resolution is to send the PATCH here and keep the dots for
   * the visit. Angular can remount this, so the store's capture is idempotent.
   * See [[2026-09-10-in-app-notifications-design]]
   */
  constructor() {
    afterNextRender(() => void this.store.enterAllScreen());
    inject(DestroyRef).onDestroy(() => this.store.leaveAllScreen());
  }
```
and a pure grouping helper:
```ts
/**
 * TODAY / YESTERDAY / EARLIER, with the time format the frames use per group.
 * Derived entirely from `createdAt` — no server field carries the group.
 */
```

- [ ] **Step 4: Wire the panel to the store**

In `notifications-panel.ts`, replace the fixture reads:
- inject `NotificationsStore`, and derive `unread`/`read` from `store.items()` by `readAt`
  rather than a `read` boolean;
- implement `markAllRead()` as `store.markAllRead()` (it was a Phase-1 no-op);
- add the count pill from `store.unreadCount()`;
- make the "View all notifications" footer link navigate to `/notifications` **and** close the
  overlay, rather than only closing it;
- load on open.

Keep the two host CONTRACTs already in that file: the animation binds on the **host** (not the
inner div), and the host must not get a `transform` (it would become the containing block for the
`fixed` panel and visibly resize the scrollbar on every open).

- [ ] **Step 5: Add the route and mount the toast host**

In `app.routes.ts`, add under the **authed** app-layout children:
```ts
      {
        path: 'notifications',
        loadComponent: () =>
          import('./features/notifications/notifications-all').then((m) => m.NotificationsAllPage),
        title: 'Notifications — 3MRAI',
      },
```
In `app-layout.ts`, connect the socket on init and disconnect on destroy, and render the
`ToastNotification` host from `ToastQueue.current()`, wiring `paused` → `pause()`/`resume()`,
`dismissed` → `dismiss(id)`, and `viewOrder` → navigate to the order from
`metadata.order_id` (or `/profile` for a `WELCOME`).

**CONTRACT: the toast is NOT an `OverlayKind`.** It is transient, carries no scrim, and may appear
while the cart is open — folding it into `active` would make showing a toast close the cart. That
contract is already recorded in `overlay-store.ts`; honour it.

- [ ] **Step 6: Delete the fixture**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
rm apps/web/src/app/fixtures/notifications.fixture.ts
grep -rn 'notifications.fixture\|NOTIFICATIONS' apps/web/src/ || echo "no fixture references"
```
Expected: `no fixture references`. Its own contract said not to wire it to an endpoint until a
service owned the concept — one now does, so it goes.

- [ ] **Step 7: Run everything and see it pass**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/web test && pnpm --filter @3mrai/web typecheck && pnpm --filter @3mrai/web lint && pnpm --filter @3mrai/web build
grep -rnE '(bg|text|border)-\[#' apps/web/src/ || echo "no arbitrary colour values"
```
Expected: tests pass, typecheck clean (the `read`→`readAt` migration is now complete across every
consumer), lint clean, build succeeds, and **no arbitrary colour values**.

- [ ] **Step 8: Verify it in the browser**

Run the dev server, sign in, and confirm: the bell badge shows a count; the panel lists real rows
with working tabs and "Mark all as read"; "View all notifications" navigates to `/notifications`;
the All screen's three pills filter and its date groups render; entering marks read while the dots
survive the visit; and placing a TestMode order produces live toasts that pause on hover.

**If you launch a headed browser, use `--window-position=-4000,-4000`** so it never steals the
user's focus.

- [ ] **Step 9: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
feat(web): wire the notifications panel and add the All screen

Panel and All screen now read the real store; the fixture is deleted. The All screen
has three filter pills (All default, unlike the panel's two tabs), TODAY/YESTERDAY/
EARLIER grouping derived from the timestamp, and mark-on-enter that keeps the arrival
dots for the visit. Toasts mount on the app layout, outside OverlayKind, so showing
one cannot close the cart.

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### Task 4.8: Web E2E for the notification surface

**Owner: the `e2e-impl` agent.**

**Files:**
- Create: `e2e/tests/web/notifications.spec.ts`

**Interfaces:**
- Consumes: the running web app, the gateway, and the existing web-spec helpers in `e2e/tests/web/`.
- Produces: browser-level coverage of the surface Phase 4 built.

- [ ] **Step 1: Write the spec**

Cover: sign in and see the bell badge; open the panel and see real rows; switch its Unread/Read
tabs; click "View all notifications" and land on `/notifications`; filter with the three pills;
confirm entering marks read (the badge clears) **while the dots persist during the visit**; reload
and see them render as read; and place a TestMode order and assert a toast appears with the right
title, then that hovering it prevents dismissal for longer than 7 seconds.

Assert on **what is on screen**, never only a count.

- [ ] **Step 2: Run it and confirm green**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && pnpm --filter @3mrai/e2e test -- web/notifications.spec.ts
```
Expected: green.

- [ ] **Step 3: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
test(e2e): web E2E for the notification panel, All screen and toasts

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
```

### Task 4.9: Propagate the design into the organized vault

**Owner: the `obsidian-vault` agent** — the sole writer of `docs/`.

**Files:**
- Modify: `docs/domains/users/specs/users-service-design.md`
- Modify: `docs/domains/events-pipeline/specs/events-pipeline-design.md`
- Modify: `docs/infrastructure/specs/terraform-modules.md`
- Modify: `docs/shared/conventions/testing.md`
- Modify: `docs/shared/conventions/logging-context.md`
- Modify: `docs/superpowers/specs/2026-08-17-web-app-foundation-design.md`
- Modify: `docs/plans/index.md` (link this plan)

**Interfaces:**
- Consumes: this plan and the spec's `propagates-to:` list.
- Produces: the decisions living in the category folders they belong to. **A spec/plan is not done
  when written — it is done when its decisions have propagated.**

- [ ] **Step 1: Hand each target its content**

Per [[doc-propagation]], with bidirectional links and a bumped `updated:` on every target:
- **`users-service-design`** — the `Notification` model, the three endpoints, the in-process
  consumer (started in `server.ts`, not `buildApp`, and why), and the WebSocket push.
- **`events-pipeline-design`** — its producers now publish to SNS; the envelope and handlers are
  unchanged because raw message delivery is mandatory on both subscriptions.
- **`terraform-modules`** — the messaging module gains the topic, the notifications queue, both
  subscriptions and both queue policies; no new Lambda-owning module, since the consumer lives
  inside Users.
- **`testing`** — the three layers for the new endpoints, and that a gateway 404 with
  `{"message":"Not Found"}` means the request never reached the service while a 401 is the good
  answer.
- **`logging-context`** — the new `app_event` values (`notification_created`,
  `notifications_marked_read`, `notification_push_failed`) and that the consumer continues the
  trace from `traceparent`.
- **`2026-08-17-web-app-foundation-design`** — the app's first WebSocket client, the notifications
  store, and the two new design tokens.

- [ ] **Step 2: Validate the vault**

Run:
```bash
cd /Users/josemartinez/Repositories/Personal/3-microservices-running-on-aws-infrastructure
nvm use && node scripts/validate-vault.mjs
```
Expected: no broken wikilinks, no frontmatter errors, and the propagation gate satisfied. The
"Propagation debt" count is the gate working, not failing.

**The validator does NOT check intra-note anchor links (`[text](#heading)`) or wikilink anchors
(`[[note#Heading]]`)** — verify any you add by hand.

- [ ] **Step 3: Commit (HUMAN / MAIN SESSION ONLY)**

**A dispatched agent never runs this.** Proposed message:

```
docs(vault): propagate the in-app notifications design into the category notes

Refs: https://linear.app/<team>/issue/JE-XXX
Plan: docs/superpowers/plans/2026-09-10-in-app-notifications.md
Spec: docs/superpowers/specs/2026-09-10-in-app-notifications-design.md
```

### 🚦 GATE 4 — Milestone close

**Batch Tasks 4.1-4.9 as one list of open PRs for the user to review and merge, then stop.** Once
they are merged, propose the PR `feature/in-app-notifications` → `main` and **stop there** — the
user merges after review. No auto-merge, ever.

---

## Concerns raised during planning

Per the brief: where the spec appears wrong, it is recorded here rather than silently deviated from.
Nothing below was changed in the plan without saying so.

### 1. `PLACED` is never emitted — decision 2's verification failed, and `ORDER_CREATED` now triggers it (RESOLVED)

**Status: RESOLVED.** The spec was corrected on 2026-09-10 and this plan implements the
correction. The finding and its evidence are kept below because they are why the design looks the
way it does — a reader who deletes the record will re-propose the rejected alternative.

**The spec said**, in decision 2 before the correction: *"'Order confirmed' is not `ORDER_CREATED`.
This design covers it with the tracking `PLACED` variant, which is a `TRACKING_STATUS_CHANGED`.
Flagged as a plan-time verification: confirm `PLACED` is always emitted on order creation; if it is
not, this decision must be revisited."*

**The verification was performed and it failed.** `PLACED` is **never published by any code path**:

- `services/tracking-go/internal/app/create_tracking.go:99-101` — *"It publishes NOTHING. Creation
  emits no SQS event — only status transitions do, which is why a TestMode run leaves five history
  rows and sends four events."* The `CreateTracking` struct holds **no publisher field at all**, so
  it is structurally incapable of emitting.
- `services/tracking-go/internal/adapter/sqs/publisher.go:88-89` — *"INVARIANT: creation NEVER emits
  an event. Only status updates do."*
- The only publish path is `UpdateStatus`, gated on `domain.AssertCanTransition(previous, requested)`.
  The row is created **at** `PLACED` and the machine is forward-only, so nothing can ever transition
  *into* `PLACED`.
- `e2e/tests/gateway/realtime-tracking.spec.ts` already asserts **four** messages for **five**
  statuses, with a CONTRACT comment giving this exact reason.

Had the design shipped unchanged, **no "order placed" notification would ever have been delivered**:
a user placing an order would see their first notification at `PROCESSING`, and the `PLACED` copy
variant, icon and tint would be dead code by construction.

**The resolution the user approved: `ORDER_CREATED` becomes the trigger for the `PLACED` copy
variant.** It is genuinely emitted, is already registered in the pipeline's dispatch
(`orderCreatedHandler` in `functions/events-pipeline/src/handlers/index.ts`), and its payload
(`OrderCreatedPayloadSchema`, `functions/events-pipeline/src/handlers/order-created.ts:24`) already
carries `order_id`, `user_id`, `created_at` and an optional `order_number` — everything the consumer
needs, with no extra lookup. The stored row is unchanged: still `type: "ORDER_STATUS"` with
`metadata.status = "PLACED"`; only the triggering event differs. `ORDER_CREATED` is therefore
admitted by the SNS filter policy (Task 1.1) and handled by the consumer (Tasks 3.5, 3.6).

**The alternative considered and rejected: having Tracking emit `TRACKING_STATUS_CHANGED` / `PLACED`
from its creation path.** Three reasons it was turned down:

1. **It would deliver a second "order confirmed" email.** `PLACED` is in the pipeline's Zod status
   enum and `TEMPLATE_BY_STATUS` already maps it to `tracking-status-changed-placed`
   (`functions/events-pipeline/src/handlers/tracking-status-changed.ts:15,38`), so the event would
   immediately fire an email seconds after the one `ORDER_CREATED` already sends — a user-visible
   change outside this design's scope.
2. **It would add a network side effect to `create_tracking.go`**, which publishes nothing today and
   carries an explicit INVARIANT saying so.
3. **It would require rewriting the E2E CONTRACT** in `e2e/tests/gateway/realtime-tracking.spec.ts`,
   which asserts four transition messages with `PLACED` explicitly absent.

**What the plan does:** admits `ORDER_CREATED` to the filter policy (Task 1.1), maps it to the
`PLACED` variant in the consumer with `occurred_at` from `created_at` and the body prefix from
`order_number.formatted` (Tasks 3.5, 3.6), and **changes nothing in Tracking**. The
`tracking-status-changed-placed` email template stays unused, and `ORDER_CREATED`'s existing "Order
confirmed" email remains the only confirmation email — the in-app notification adds no email.

One thing the record should keep, because it still misleads: the events-pipeline **is** provisioned
for a tracking `PLACED` — its Zod enum includes it, `TEMPLATE_BY_STATUS` maps it, and
`email/catalog.ts` renders a sample. A reader finding that template reasonably concludes the tracking
event exists. It does not, and re-enabling it is exactly the duplicate-email mistake above.

### 2. "Registered as a Fastify plugin" is the wrong home for the consumer (MEDIUM — refined in the plan)

**The spec says**, decision 5: the consumer is *"registered as a Fastify plugin… starts after the
container is built and stops on `onClose`."*

`services/users/src/server.ts` carries an explicit CONTRACT that the metrics poller is started
there and **not** in `buildApp()`, *"because the test suite calls buildApp too, and a live timer in
every run would hit the database outside any test's control."* An SQS long-poll inside `buildApp`
has the same hazard and worse: every Vitest run would open a real connection and **consume and
delete real messages**.

**What the plan does (Task 3.6):** constructs the consumer in the Awilix container and **starts it
in `server.ts`**, stopped on `SIGTERM` beside the poller. Everything the spec actually wanted — one
process, shared container, shared Prisma client and logger, stopped on shutdown — holds. I read this
as a faithful refinement of the intent and flag it here rather than treating it as silent deviation.

### 3. The spec asks for an nginx `location` block that is not needed (LOW — refined in the plan)

**The spec says**, in Testing: the three routes need *"an nginx `location` block
(`infra/modules/compute/nginx/nginx.conf`) — a new top-level path without one falls through to
`location /` and silently reaches Users' default handling."*

For a path owned by a **different** service that is exactly right, which is why `/v1/products`,
`/v1/cart` and `/v1/trackings` each have one. But `/v1/notifications` **is** served by Users, and
`location /` already proxies to `users:3000` with `x-user-id` injected. The route map records this
same reasoning for `/v1/users/me`: *"No nginx `location` needed: /v1/users/me falls under
`location /`, which already proxies to Users."*

**What the plan does (Task 1.4):** adds the three gateway route-map entries (mandatory) and no nginx
block, with a comment recording why. The spec's underlying warning is preserved — Task 1.4's Step 3
asserts a **401**, and calls out that a 404 carrying the gateway's own `{"message":"Not Found"}`
means the request never reached the service.

### 4. Users has no IAM role to attach the spec's grants to (LOW — recorded in the plan)

**The spec says**, decision 6: Users gets `WS_MANAGEMENT_ENDPOINT` *"plus IAM permission for
`@connections` and the DynamoDB connections table."*

`infra/modules/compute/main.tf` declares only `aws_iam_role.ecs_execution`, used as
`execution_role_arn` on the **nginx** task. There is no `task_role_arn` anywhere in `infra/`, and no
ECS task definition for Users at all — it runs as a docker-compose service with static
`AWS_ACCESS_KEY_ID=test` credentials, and Floci performs no IAM authorization.

**What the plan does (Task 1.5):** records this rather than inventing a role, and corrects the
now-stale `outputs.tf` comment claiming the WS endpoint's only consumer is a Lambda. **The risk worth
naming: a real AWS deployment would need a Users task role created from scratch, and the absence of
the grant will not surface locally** — it would fail only on first deploy.

### 5. The `.pen` token values must be read, not guessed (LOW)

Task 4.1's `styles.css` snippet shows a placeholder hex for `--color-brand-navy-light`. The real
value must come from `GetVariables()` after the `.pen` is updated, and the plan says so. Flagged
because a plausible-looking hex is exactly the kind of thing that survives review unexamined.

### 6. `metadata.order_number` stores only the display form (LOW)

The wire payload carries `order_number: { raw, formatted }`, and the plan's consumer stores only
`formatted` in `metadata` (the display string the copy already embeds). That matches the spec's
model comment (`order_number?`) and everything the design's screens need. Noting it because a future
"View order by number" lookup would want `raw`, and adding it later means a data migration for
existing rows — cheap now, not free later. **Not changed**: the spec's model is explicit and YAGNI
applies.

---

## Self-review

Run against the spec with fresh eyes, per the writing-plans skill. Findings were fixed inline.

### 1. Spec coverage

| Spec section | Task(s) |
|---|---|
| D1 — Postgres in Users, not DynamoDB/Cognito | 3.1 |
| D2 — SNS fan-out, raw delivery, filter policy | 1.1, 2.1-2.5 |
| D2 — blocking Floci SNS POC + lesson note | 0.1-0.4 (**hard gate**) |
| D2 — `PLACED` verification | Concerns §1 (**failed; resolved — `ORDER_CREATED` is the trigger**) |
| D2 (corrected) — `ORDER_CREATED` admitted and handled | 1.1 (filter policy), 3.2, 3.5, 3.6, 3.9, 3.10 |
| D3 — title/body/metadata model, audit fields, no FK | 3.1 |
| D4 — no idempotency key; delete after commit | 3.1 (Global Constraints), 3.6 |
| D5 — consumer in-process, discards by type, never throws, continues the trace | 3.6 (+ Concerns §2) |
| D6 — Users pushes, `cognito_sub` locally, `NOTIFICATION_CREATED`, never fails persistence | 3.4, 3.5 |
| D7 — three endpoints, cap 50, no pagination, `ids` list, empty→200, single→404 | 3.7, 3.8 |
| D8 — mark-on-enter with the arrival highlight | 4.3, 4.7 |
| D9 — no retention job | 3.1 Step 8 (proves no `DELETE` grant) |
| D10 — 7s pausable toast, one constant, queue bounded | 4.4, 4.6 |
| Eleven copy variants (verbatim) | 3.2, 4.5 |
| Email title parity (verification task) | 3.3 (four transition titles pinned; `PLACED` documented as intentionally independent) |
| Two design-token gaps, fixed upstream | 4.1 |
| All screen: 3 pills, date groups, subtitle | 4.7 |
| Panel: count pill, mark-all, footer link | 4.7 |
| WebSocket client with reconnection | 4.4 |
| Three test layers per endpoint | 3.8, 3.9, 3.10 |
| Load-test scenario | 3.11 |
| Observability: `app_event`s, traceparent, PRODUCER span | 3.4, 3.5, 3.6 |
| Gateway route map (+ nginx) | 1.4 (+ Concerns §3) |
| Env wiring, generated never hand-edited | 1.3, 2.2, 4.4 Step 6 |
| Doc propagation | 4.9 |

**Gaps found and fixed:**
- **No task closed the propagation loop.** The spec's `propagates-to:` lists six targets and
  [[doc-propagation]] makes this a gate; added **Task 4.9**.
- **No load-test task**, though CLAUDE.md requires one when a route changes how users reach an
  existing flow (the bell polls `unread-count` on every page); added **Task 3.11**.
- **`WS_CONNECTIONS_TABLE`/`WS_CONNECTIONS_GSI` were missing** from the env wiring — the spec names
  only `WS_MANAGEMENT_ENDPOINT`, but the GSI query needs both; added to Tasks 1.3 and 2.2.
- **The web had no WS URL.** The generator wrote `ws_url` only into `.env.local.debug` for the E2E
  harness; added `NG_APP_WS_URL` in Task 4.4 Step 6.
- **Users had no CLIENT-span helper** (it has `withPublishSpan`/`withWorkflowSpan` only), which the
  PRODUCER span in D6 needs; added `client-span.ts` in Task 3.4 Step 6.
- **The soft-delete `isDeleted` map** would have silently missed the new model, and a test asserts
  schema/map agreement; added to Task 3.1 Step 4.

### 2. Placeholder scan

No `TBD`, no "add appropriate error handling", no "write tests for the above", no "similar to Task
N". Every code step carries real code; every test step carries the real test or, for the E2E and
design tasks owned by other agents, an explicit enumerated case list.

**Fixed:** three "Commit" steps originally read as plain instructions; every one now names the
Conventional-Commits message and states that **the main session runs it after the A/B/C/D/E menu** —
a dispatched agent never does.

**Deliberately enumerated rather than fully written out:** Tasks 3.9, 3.10, 3.11, 4.8 (owned by
`e2e-impl`, which verifies contracts against `openapi.yaml` rather than a plan's transcription) and
the frame-driven markup in 4.7 (owned by `web-impl`, which reads the `.pen` live). Each lists every
case to cover, so nothing is left to invention.

### 3. Type consistency

Checked every name used across task boundaries:
- `SnsEventPublisher(client, topicArn)` — defined 2.1, registered 2.2. ✓
- `EVENTS_TOPIC_ARN` / `NOTIFICATIONS_QUEUE_URL` / `WS_MANAGEMENT_ENDPOINT` /
  `WS_CONNECTIONS_TABLE` / `WS_CONNECTIONS_GSI` — identical in 1.3 (generator), 2.2 (Zod schema),
  3.4 and 3.6 (readers). ✓
- `welcomeCopy()` / `placedCopy({orderNumberFormatted})` /
  `trackingCopy({status, orderNumberFormatted, changedAt})` / `TRACKING_TITLES` /
  `TRACKING_EVENT_STATUSES` — defined 3.2, consumed 3.3 and 3.5. ✓
- `TrackingStatus` (five, the STORED `metadata.status` domain) vs `TrackingEventStatus` (four, what
  a `TRACKING_STATUS_CHANGED` event may carry) — **intentionally two types**, defined 3.2, used in
  3.5 (`NotificationMetadata.status` takes the five-wide one; `isTrackingEventStatus` narrows to the
  four-wide one) and 3.6. The web's own `TrackingStatus` (`types.ts:173`) is already five wide and
  is **unchanged**; there is no web `TrackingEventStatus`, because the web never parses a tracking
  event. ✓
- `publishToUser(cognitoSub, message)` — defined 3.4, called 3.5. ✓
- `CreateNotificationCommand.execute(envelope) → "created" | "discarded"` — defined 3.5, called 3.6. ✓
- `NOTIFICATIONS_LIMIT` / `WINDOW_DAYS` — defined 3.7, imported by 3.8's schemas. ✓
- `NotificationsPage { items, unread_count, window_total, window_days }` (server, 3.7) vs
  `NotificationsPage { items, unreadCount, windowTotal, windowDays }` (web, 4.2) — **intentionally
  different**: snake_case on the wire, camelCase in the view model, converted only in
  `notifications-api.ts`. Both spellings are stated in their own Interfaces blocks. ✓
- `AppNotification.readAt` — widened in 4.2, consumed 4.3/4.5/4.7. **`read: boolean` is gone**, and
  4.7 Step 7's typecheck is what proves no consumer still reads it. ✓
- `visualFor(notification)` — defined 4.5, reused 4.6. ✓
- `TOAST_DISMISS_MS` — defined 4.4, bound in 4.6. ✓

**Inconsistencies found and fixed:**
- The Users test-container fake originally exposed `unreadCount` where the command calls
  `db.notification.count` — corrected in 3.5's fake.
- `MarkReadResult` was `{updated, unread_count}` on the server and `{updated, unreadCount}` on the
  web with no conversion stated; the mapping is now explicit in 4.2's client.
- Task 3.1's model comment initially matched the spec's `createdBy String?`; the spec's own snippet
  says `createdBy String` (non-nullable), and the consumer runs outside a request, so the plan
  states the explicit-stamp requirement in 3.1, 3.5 and its test.
- Ground-truth item 1 referenced a non-existent "Task 0.6"; it now points at Concerns §1.

### 4. Delta review — the 2026-09-10 spec correction (`ORDER_CREATED` triggers `PLACED`)

Re-run over only what the correction changed, per the brief.

- **Files/Interfaces blocks:** every touched task (1.1, 3.2, 3.3, 3.5, 3.9, 3.10, 3.11, 4.2, 4.5)
  keeps both blocks; 3.2's, 3.3's, 3.5's and 4.2's Interfaces were **extended** (new exports, the
  two-type split, the confirmed `ORDER_CREATED` payload fields), never removed. ✓
- **Guarded commit steps:** the four rewritten commit messages (1.1, 3.3, 3.5, 3.10) still sit under
  a "**A dispatched agent never runs this**" heading. No commit step was added or removed. ✓
- **Placeholders:** none introduced. The new `ORDER_CREATED` branch in 3.5 is real code; its four
  new tests are real tests; the `ORDER_CREATED` payload in the fixture uses the field names
  `OrderCreatedPayloadSchema` actually declares, read off
  `functions/events-pipeline/src/handlers/order-created.ts:24` rather than guessed. ✓
- **Test counts updated where the edits changed them:** 3.2 stays at 13 (one `it.each` case moved
  into a dedicated `placedCopy` block of two), 3.3 rises 15 → 16 (the parity loop plus the
  unpinned-`PLACED` assertion), 3.5 rises 12 → 15 (four added, one `it.each` case removed). ✓
- **Two counts, stated as two:** 3.10 now spells out FIVE `NOTIFICATION_CREATED` frames against FOUR
  `TRACKING_STATUS_CHANGED` frames and says why they differ, so neither gets "fixed" into the other.
  3.11 carries the same note for load-test expectations. ✓
- **Inconsistency found and fixed during the delta pass:** Phase 0's POC published `ORDER_CREATED` as
  its *filtered-out* type. With the corrected three-type policy that probe would have proven nothing
  (it would assert a type the real policy admits is rejected), so `FILTERED_TYPE` is now
  `PASSWORD_RESET_REQUESTED`, and the POC's throwaway filter policy mirrors the real three. ✓
- **Second inconsistency fixed:** Task 2.5's queue-drain assertion listed `ORDER_CREATED` among the
  types that prove the filter is broken. It is now among the expected ones. ✓

---

## Related

- [[2026-09-10-in-app-notifications-design]] — the approved spec this plan implements.
- [[users-service-design]] — gains the `Notification` model, three endpoints, the consumer and the push.
- [[events-pipeline-design]] — its producers change transport; its envelope and handlers do not.
- [[terraform-modules]] — gains the SNS topic, the notifications queue and both subscriptions.
- [[testing]] — the three-layer convention these endpoints satisfy.
- [[logging-context]] — governs what the consumer and the push may log.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the socket and connections table reused.
- [[2026-08-17-web-app-foundation-design]] — the Angular/NgRx/Tailwind base the web surface builds on.
- [[user-id-vs-cognito-sub-ownership-key]] — the trap the GSI query must not fall into.
- [[soft-delete]] / [[ADR-0004-soft-delete-only]] / [[audit-fields]] / [[nano-id]] — conventions the model follows.
- [[env-files]] — how the new identifiers reach each service.
- [[ADR-0017-floci-local]] — the posture behind the mandatory Phase 0 POC.
- [[ADR-0019-distributed-tracing-opentelemetry]] — where the continued trace and PRODUCER span report.
- [[pencil-design-extraction]] — the method for reading the frames and fixing token gaps upstream.
- [[git-workflow]] — the A/B/C/D/E confirmation menu every commit step defers to.
- [[doc-propagation]] — the convention Task 4.9 satisfies.
