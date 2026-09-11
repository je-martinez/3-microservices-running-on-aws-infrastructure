---
title: In-App Notifications Design
type: spec
area: shared
status: accepted
created: 2026-09-10
updated: 2026-09-10
tags:
  - type/spec
  - area/shared
  - status/accepted
propagates-to:
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[terraform-modules]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[2026-08-17-web-app-foundation-design]]"
related:
  - "[[users-service-design]]"
  - "[[events-pipeline-design]]"
  - "[[terraform-modules]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[2026-08-17-web-app-foundation-design]]"
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

# In-App Notifications Design

## Corrections after approval

**2026-09-10 — Decision 2's plan-time verification ran and failed; `ORDER_CREATED` replaces the
tracking `PLACED` variant as the "order placed" trigger.** Decision 2 originally flagged as a
plan-time verification task that `TRACKING_STATUS_CHANGED` with `status: "PLACED"` must be
confirmed as always emitted on order creation. That check has now run, by reading the code, and
failed: `PLACED` is **never emitted by any code path** — it is the status a tracking row is
*created* in, not a transition, and Tracking's transition-only publisher
(`services/tracking-go/internal/app/update_status.go`) never fires for it; `create_tracking.go`
holds no publisher at all. The E2E suite already documents this
(`e2e/tests/gateway/realtime-tracking.spec.ts`, asserting four transition messages with `PLACED`
explicitly absent). Had this shipped unchanged, no "order placed" notification would ever have
been delivered. The correction: `ORDER_CREATED` — verified as genuinely emitted and already
wired into the pipeline's dispatch — becomes the trigger for the `PLACED` copy variant. See the
rewritten decision 2 below, the corrected [Design source](#design-source--the-pen-frames-read-live-over-the-pencil-mcp-not-from-an-html-export)
row, and [Scope](#scope) for the full correction. This is exactly what the plan-time verification
was for: it caught a wrong assumption before implementation rather than after.

## Goal

Give users an in-app notification inbox: a bell/panel, a full-page list, and live toasts.
Notifications are produced from events the system already emits, stored in the Users service's
own Postgres, read through new Users endpoints, and pushed live over the existing WebSocket
channel established by [[2026-08-05-realtime-tracking-events-websocket-design]].

This design spans **four fronts** — infrastructure (SNS fan-out), three event producers in three
languages (TypeScript, .NET, Go), the Users service (schema, consumer, endpoints, WebSocket
push), and the web app (socket client, panel, toasts, full-page list). It is therefore likely to
need more than one milestone with explicit stop points; the implementation plan phases it.

## Approved decision 1 — Store: Postgres in Users, not DynamoDB, and not Cognito

The user asked whether notifications could live in "some AWS service related to Cognito." Record
plainly: **no such service exists.** Cognito is an identity directory — no inbox, no read/unread
state, no message history. Custom attributes (`custom:*`) cap at 2048 chars, cannot be queried,
and corrupt under concurrency. Pinpoint/SNS/SES are delivery channels, not queryable per-user
stores. The canonical AWS pattern would be DynamoDB keyed by the Cognito identity — which is what
this repo already does for `websocket_connections` (see
[[2026-08-05-realtime-tracking-events-websocket-design#Data model — `websocket_connections` table]]).

The user chose **Postgres in the Users service** over DynamoDB. The genuine upside discovered
while exploring: because the store is Users' own database, the natural key is the internal
`usr_` id (`user_id`), which sidesteps the silent-empty-result trap documented in
[[user-id-vs-cognito-sub-ownership-key]] — that trap only bites when querying a
`cognito_sub`-keyed index with an internal id. There is no such index here.

**Accepted consequence:** this is not the DynamoDB reference pattern the repo otherwise favours
for AWS-recognisability.

## Approved decision 2 — Fan-out via SNS, because SQS is point-to-point

The user first proposed adding an `sqs-consumer` in Users on the existing queue. That specific
shape does not work: the shared queue already has one consumer (the events-pipeline Lambda), and
SQS is point-to-point — each message is delivered to exactly **one** of two competing consumers,
so emails and notifications would each go missing at random. Correctness was the objection, not
the library.

Verified topology at design time: `infra/modules/messaging/main.tf` declares exactly one main
queue (`${var.context.id}-events`) plus one DLQ, and there is no SNS or EventBridge domain
fan-out anywhere in `infra/modules/` today.

Approved topology:

```
Users ─┐
Orders ─┼─→ SNS topic ─┬─→ SQS <id>-events ────────→ events-pipeline Lambda (unchanged)
Tracking ┘             └─→ SQS <id>-notifications ──→ Users (sqs-consumer)
```

- **Raw message delivery is mandatory on both subscriptions.** Without it SNS wraps the body in
  its own JSON envelope, and the pipeline's `EnvelopeSchema` would receive an SNS envelope instead
  of the domain envelope — silently breaking all three existing handlers. With raw delivery the
  body is byte-for-byte what is published today, and **the pipeline changes not one line**.
- `MessageAttributes` (`type`, `source`, `traceparent`) survive raw delivery. This matters twice:
  the traceparent keeps distributed tracing intact (see [[logging-context]] and
  [[ADR-0019-distributed-tracing-opentelemetry]]), and `type` enables a **subscription filter
  policy** so the notifications queue receives only `USER_CREATED`, `ORDER_CREATED`, and
  `TRACKING_STATUS_CHANGED`.
- **Corrected 2026-09-10 — `ORDER_CREATED` is admitted; `PLACED` is never emitted.** This decision
  originally flagged, as a plan-time verification, that `TRACKING_STATUS_CHANGED` with
  `status: "PLACED"` needed confirming as always emitted on order creation. That check has now
  run, by reading the code, and failed: `PLACED` is the status a tracking row is *created* in, not
  a transition, and is **never emitted by any code path** — Tracking's publisher only fires from
  the transition path (`services/tracking-go/internal/app/update_status.go`);
  `create_tracking.go` holds no publisher at all. This is already documented in
  `e2e/tests/gateway/realtime-tracking.spec.ts`'s CONTRACT comment, which asserts exactly the four
  transition statuses and explicitly excludes `PLACED`. `ORDER_CREATED` is therefore the real
  trigger for "order placed": it is genuinely emitted, already registered in the pipeline's
  dispatch (`orderCreatedHandler` in `functions/events-pipeline/src/handlers/index.ts`), and its
  handler already sends the "Order confirmed" email
  (`functions/events-pipeline/src/handlers/order-created.ts:98`, template key `order-created`).
  This is the plan-time verification the spec asked for, working as intended — it caught a wrong
  assumption before implementation, not after.

  The alternative considered first and then withdrawn: having Tracking itself emit
  `TRACKING_STATUS_CHANGED` / `PLACED` on row creation. This was approved, then dropped once
  verification showed it would also require enabling the pipeline's already-provisioned `PLACED`
  email (`PLACED` is in the Zod status enum and `TEMPLATE_BY_STATUS` maps it to
  `tracking-status-changed-placed`,
  `functions/events-pipeline/src/handlers/tracking-status-changed.ts:15,38`) — which would deliver
  a **second** "order confirmed" email seconds after the one `ORDER_CREATED` already sends.
  Rejected for that reason, plus two more: it would add a network side effect to
  `create_tracking.go`, which publishes nothing today, and it would require rewriting the E2E
  CONTRACT above.
- `AUTH_OTP_REQUESTED` and `PASSWORD_RESET_REQUESTED` produce no notification and must not reach
  the notifications queue at all.
- All three producers change from `SendMessageCommand` to SNS `PublishCommand`
  (`EVENTS_QUEUE_URL` → `EVENTS_TOPIC_ARN`): TypeScript (Users,
  `services/users/src/shared/messaging/event-publisher.ts`), .NET (Orders), Go (Tracking).

### Blocking prerequisite — SNS on Floci is unverified

No existing lesson covers SNS on Floci — [[floci-sqs-lambda-docdb-support]] and
[[2026-08-05-realtime-tracking-events-websocket-design]]'s WebSocket/DynamoDB verification cover
adjacent ground, but neither exercises SNS. Per the precedent of that same design's throwaway POC
(see [Verification results (POC, 2026-08-05)](2026-08-05-realtime-tracking-events-websocket-design.md#verification-results-poc-2026-08-05)),
a throwaway POC must run **first** and its findings be recorded as a lesson note. The POC must
prove, not assume: a topic created via Terraform; two queues subscribed; `Publish`; and **read
from both queues** confirming each got the same message with body intact and MessageAttributes
present; plus that the filter policy actually filters.

Distinguish two failure modes explicitly:

- If **fan-out** fails outright, fall back to the already-chosen alternative: the pipeline
  forwards to a Users queue with `SendMessage`, using only SQS, which is verified.
- If only the **filter policy** fails but fan-out works, the design still stands — the Users
  consumer discards by `type` in code (it does this anyway as defence in depth).

Knowing which one broke is the point.

## Approved decision 3 — Data model: title/body/metadata, deliberately simple

The recommended alternative was storing structured facts and rendering copy at read time, so
copy lives in one place. The user chose to store rendered `title`/`body` plus a `metadata` JSON.

**Accepted consequence:** copy now lives in two places — the email templates in the pipeline and
the Users consumer. A copy change leaves already-stored notifications with the old text.

**The defensible reading, recorded as such:** rendered copy is a historical fact — "Your order
has shipped" is what the user was told that day, much as a sent email is not retroactively
rewritten.

**`metadata` is what prevents the real failure of storing text only:** without `status`/
`order_id` the web could only print the string — no icon, no tint, no "View order" CTA. Keeping
them in `metadata` means presentation is still derived, never baked into the text.

```prisma
model Notification {
  id       String    @id                       // ntf_ nano-id
  userId   String    @map("user_id")
  type     String                              // "WELCOME" | "ORDER_STATUS"
  title    String
  body     String
  metadata Json                                // { status?, order_id?, order_number?, occurred_at }
  readAt   DateTime? @map("read_at") @db.Timestamptz(6)

  // audit fields, exactly as User / UsersCognitoData / UsersCognitoEvent carry them
  createdBy String   @map("created_by")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedBy String?  @map("updated_by")
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  deletedBy String?  @map("deleted_by")
  deletedAt DateTime? @map("deleted_at") @db.Timestamptz(6)

  @@map("notifications")
  @@index([userId, readAt])
  @@index([deletedAt])
}
```

Follows the conventions actually present in `services/users/prisma/schema.prisma`: full
soft-delete columns, `@db.Timestamptz(6)`, snake_case `@map`, `@@index([deletedAt])`. See
[[soft-delete]], [[ADR-0004-soft-delete-only]], [[audit-fields]], [[nano-id]].

- `readAt` is a timestamp, not an `isRead` boolean — same shape as `deletedAt`, and answers
  "when" as well as "whether."
- `type` stays a column (not inside `metadata`): it drives the toast eyebrow and the CTA, and is
  needed on every row — that is structure, not detail.
- `occurred_at` lives inside `metadata` and is therefore **not indexable**. Acceptable because
  ordering is by `createdAt` and the cap is 50. If ordering by `occurred_at` is ever needed, it
  gets promoted to a column.
- **No foreign key** from `userId` to `User.id`, unlike the sibling tables. A
  `TRACKING_STATUS_CHANGED` can arrive for a user row that does not yet exist or is soft-deleted;
  an FK would turn that into an insert failure retried to the DLQ. The notification is stored,
  and the `GET` (which filters by the authenticated user) simply never serves it.

## Approved decision 4 — No idempotency key. Duplicates are an accepted outcome.

The recommended alternative was an `eventId @unique` (or reusing the event id as the PK), argued
twice: SQS is at-least-once, and redelivery is routine (delete fails or arrives late, visibility
timeout expires mid-transaction, the service restarts between insert and delete) — the
user-visible result is the same notification twice, two unread dots, and a wrong badge count.
Both sibling precedents do guard this: the pipeline has a unique index on `event_id` in
DocumentDB, and `UsersCognitoEvent.messageId` is `@unique` in this very database.

**The user chose to omit it entirely.** Record this as a deliberate, informed decision, not an
oversight — a reader in three months should not "fix" it by adding a unique index. The accepted
consequence, stated plainly: **on SQS redelivery the user sees a duplicate notification.**

Zero-cost mitigation that **is** in scope: delete the SQS message only after the insert commits
(`sqs-consumer`'s default when the handler does not throw). This does not remove at-least-once
delivery; it narrows the duplicate window to a crash between commit and delete.

## Approved decision 5 — Consumer runs inside the Users process

[sqs-consumer](https://www.npmjs.com/package/sqs-consumer) registered as a Fastify plugin,
sharing the Awilix container, Prisma client, and logger with the HTTP surface; starts after the
container is built and stops on `onClose`.

Rejected alternatives:

- A separate worker process/entrypoint — adds a deployable component, a compose service, an env
  file, and a health check, to buy isolation this local Floci-based project does not need yet.
  1 → 2 is later an entrypoint change, not a redesign.
- A Lambda writing into Users' Postgres — a second writer from outside the owning service,
  breaking data ownership.

Consumer behaviour:

- Discards non-notification `type`s in code (defence in depth alongside the SNS filter policy).
- Maps event → row using the copy map of the eleven variants (see
  [Design source](#design-source--the-pen-frames-read-live-over-the-pencil-mcp-not-from-an-html-export)
  below). Three trigger events, per the corrected mapping (2026-09-10): `USER_CREATED` → the
  `WELCOME` variant; `ORDER_CREATED` → the `PLACED` variant; `TRACKING_STATUS_CHANGED` → the four
  real transition variants (`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED`) — `PLACED`
  is excluded from this last group since Tracking never emits it. `ORDER_CREATED`'s payload must
  supply the order number for the `<ORDER_NUMBER>` body prefix; the exact field name on that
  payload needs confirming against `functions/events-pipeline/src/handlers/order-created.ts` at
  implementation time rather than guessed here.
- **Never throws on permanent errors** (an invalid payload is logged and consumed) — same
  rationale as the pipeline's `PermanentError`: throwing would retry to the DLQ with no chance of
  success.
- Continues the trace from the `traceparent` message attribute, as the pipeline does.

## Approved decision 6 — Users pushes the realtime message, not the pipeline

Realtime is in scope (the user confirmed). Users gets `WS_MANAGEMENT_ENDPOINT` (today injected
only into the events-pipeline, `infra/environments/local/main.tf:411`) plus IAM permission for
`@connections` and the DynamoDB connections table, and after persisting a notification pushes to
the user's open sockets — reusing the pattern in
`functions/events-pipeline/src/shared/realtime/websocket-publisher.ts`: query the
`by-cognito-sub` GSI, reactive delete on `410 Gone`.

Rejected alternative: leaving the push in the pipeline. Its existing message is `{type, order_id,
status, previous_status, changed_at}` — not a notification (no `title`/`body`), and critically
**`WELCOME` would never be pushed at all** (the `user-created` handler does not publish to the
socket), contradicting the `Notifications — Welcome` frame, which specifies a welcome toast with
its own eyebrow and CTA.

- Users resolves `user_id → cognito_sub` with a local `SELECT` on its own `users` table (the
  `cognitoSub` column already exists) — no remote call.
- New message shape: `{ "type": "NOTIFICATION_CREATED", "notification": { id, type, title, body,
  metadata, read_at }, "unread_count": n }`. `unread_count` rides along so the badge updates
  without a second request.
- **CONTRACT: the push must never fail the persistence.** Same contract the pipeline already
  documents: if `PostToConnection` fails, the notification is stored and appears when the panel
  is opened. Realtime is an enhancement, never the source of truth.
- The pipeline's existing `TRACKING_STATUS_CHANGED` push (see
  [[2026-08-05-realtime-tracking-events-websocket-design]]) is left untouched — it serves live
  order-detail updates, a different purpose. Two message types over one socket.

## Approved decision 7 — API surface (cap 50, no pagination)

The user explicitly chose a hard cap of **50** and **no pagination**, with `unread_count`
computed separately so the count pill stays exact when the cap truncates the list.

| Method | Route | Shape |
|---|---|---|
| GET | `/v1/notifications?filter=all\|unread\|read` | → `{ items, unread_count, window_total, window_days: 90 }`; newest 50 by `createdAt desc`; `filter` defaults to `all` |
| GET | `/v1/notifications/unread-count` | → `{ unread_count }` |
| PATCH | `/v1/notifications/read` | body `{ ids: [...] }` → `{ updated: n, unread_count }` |

- `user_id` always comes from the Cognito JWT, never from a parameter or body.
- **The PATCH takes a list of ids** (the user's explicit instruction) and thereby replaces the
  separate `read-all` endpoint originally proposed — one write endpoint covers all three cases:
  entering the All screen, "Mark all as read," and marking a single one (a list of one).
- `WHERE id IN (:ids) AND user_id = :sub AND read_at IS NULL`. The `user_id` clause **is** the
  ownership check — another user's ids simply do not match and are not counted. The `read_at IS
  NULL` clause makes it idempotent, which matters because the mark-on-enter can fire twice on an
  Angular remount.
- An empty `ids` list returns 200 with `updated: 0`, not 400 — arriving with nothing unread is
  the normal case.
- The `ids` list is capped at 50, matching the list cap.
- A single-id PATCH affecting 0 rows returns 404, indistinguishable from "does not exist" —
  deliberately, so it does not leak the existence of other users' notifications.
- `window_total` is a 90-day `count` **without** the cap, so it can exceed `items.length` — this
  is exactly why the counters are separate.

## Design source — the `.pen` frames (read live over the Pencil MCP, not from an HTML export)

These were read from the live `.pen` via the Pencil MCP, per [[pencil-design-extraction]].
Frames: `gRMM7` "Notifications — Status Variants," `I3GQwM` "Notifications — Welcome," `v7j7HT`
"Notifications — All," `p6PjdF` "Mobile — Notifications All," and components `qwO6X` Notification
Item, `LWQ8g` Notifications Panel, `jYz4h` Toast Notification.

Presentation is driven by **two axes**, deliberately not flattened into one enum: `type` decides
the toast eyebrow and the CTA; `status` decides the icon and the tint.

The eleven variants (copy verbatim from the `.pen`). **Trigger column added 2026-09-10** to make
explicit which event produces each row, since `PLACED` is not triggered the way its neighbours
are — see the correction in decision 2 above. Do not wire `PLACED` to a tracking status:

| type / status | trigger event | icon | bubble tint | icon colour | title | body |
|---|---|---|---|---|---|---|
| WELCOME | `USER_CREATED` | `party-popper` | `brand-navy-light` | `brand-navy` | Welcome to 3MRAI! | Your account is ready. Start exploring orders, tracking and more. |
| PLACED | `ORDER_CREATED` (**not** `TRACKING_STATUS_CHANGED` — `PLACED` is never emitted as a tracking status, see decision 2) | `receipt-text` | `#E5E7EB` (see gap below) | `text-secondary` | Order placed | `<ORDER_NUMBER>` · Received and confirmed. We'll email your receipt. |
| PROCESSING | `TRACKING_STATUS_CHANGED` | `package` | `warn-bg` | `warn-text` | Your order is being prepared | `<ORDER_NUMBER>` · Being picked and packed for shipment. |
| SHIPPED | `TRACKING_STATUS_CHANGED` | `warehouse` | `info-bg` | `info-blue` | Your order has shipped | `<ORDER_NUMBER>` · Handed to the carrier and on its way to you. |
| OUT_FOR_DELIVERY | `TRACKING_STATUS_CHANGED` | `truck` | `brand-orange-light` | `brand-orange-text` | Out for delivery | `<ORDER_NUMBER>` · Arriving today, by 6:00 pm. |
| DELIVERED | `TRACKING_STATUS_CHANGED` | `package-check` | `success-bg` | `success-text` | Delivered | `<ORDER_NUMBER>` · Delivered Aug 5, 3:31 pm. |

The `PLACED` row's stored shape is otherwise unchanged: it still persists as
`type: "ORDER_STATUS"` with `metadata.status = "PLACED"`, identically to the four tracking-driven
rows — only the triggering event differs. Nothing in the `Notification` data model (decision 3)
or the API surface (decision 7) needs to know which event produced a row.

Toast eyebrow: `ORDER UPDATE` for tracking, `WELCOME` for welcome. Toast CTA: "View order" for
tracking, "View my profile" for welcome (welcome has no `order_id`, consistent with the envelope
where `order_id` is null for `USER_CREATED`).

`OUT_FOR_DELIVERY` and `DELIVERED` bodies carry a date/time, so the consumer composes them from
the event payload rather than using a static string. The `<ORDER_NUMBER>` prefix (e.g.
`ORD-3MRAI-10482`) comes from the tracking payload's `order_number.formatted`, which already
travels on the envelope and is **omitted** when the order has none
(`services/tracking-go/internal/adapter/sqs/envelope.go`) — so the consumer must tolerate its
absence.

The frame's own subtitle asserts "Titles match the email headings in
tracking-status-changed." Record this as a **plan-time verification task, not an assumption**:
the pipeline maps status → template key (`TEMPLATE_BY_STATUS` in
`functions/events-pipeline/src/handlers/tracking-status-changed.ts`:
`tracking-status-changed-placed` … `-delivered`) and the actual copy lives in
`assets/email/emails.pen`, so the match must be checked against those five templates.

### Design-system gaps to fix upstream (do not hand-edit styles.css; do not substitute the nearest token)

Per [[pencil-design-extraction]], these are reported rather than worked around:

1. **`brand-navy-light` does not exist** in `GetVariables()` (30 variables; `brand-navy`,
   `brand-navy-deep`, and `brand-orange-light` exist, this one does not). Both welcome variants
   reference it. Must be added to the `.pen` via `SetVariables`, then propagated into
   `apps/web/src/styles.css` and `apps/web/DESIGN.md`.
2. **`PLACED` uses a hard-coded `#E5E7EB`** in all eleven variants — exactly the value of the
   existing `border-color` token, but not referenced as a variable. Candidate for a proper
   neutral token (e.g. `neutral-bg`/`neutral-text`) rather than an arbitrary hex.

Also note the MCP quirk that `SetVariables` is in-memory until a human saves the `.pen` in the
desktop app; verify with `git hash-object` vs `git rev-parse HEAD:<path>` before reporting the
design change as done.

### The All screen (`v7j7HT` / `p6PjdF`)

- **Three filter pills** (All / Unread / Read) with **All** as default — this differs from the
  panel, which uses two tabs (Unread / Read). Both are served by `?filter=`.
- **Date grouping TODAY / YESTERDAY / EARLIER**, with a different time format per group (relative
  "12 min ago" or clock "8:15 am" for recent, full "Aug 2 · 10:24 am" for EARLIER). Pure
  presentation, derived in the web from the timestamp — no new field.
- Unread rows sit on `bg-subtle` with the `Unread Dot` enabled; read rows are transparent
  (`#FFFFFF00`) with the dot disabled. So `readAt` governs two visual properties, not one.
- Subtitle "3 unread · 7 in the last 90 days" is what motivated `window_total` / `window_days`.
- The panel (`LWQ8g`) additionally has a count pill, "Mark all as read," and a "View all
  notifications" footer link that navigates to this screen.

### Approved decision 8 — mark-on-enter, with the arrival highlight preserved

The frame shows three unread rows with active dots **and** a "Mark all as read" button while on
that screen, which literally contradicts "entering marks everything read." This contradiction was
surfaced; the user chose: **send the PATCH on entering, but keep the highlight for the duration
of the visit.** The client (NgRx) remembers which ids arrived unread and keeps their dot and
`bg-subtle` until the screen is left; on reload they render as read. This satisfies both the
frame and the instruction, and — worth stating — **costs the backend nothing**: the server has no
notion of "read but still highlighted."

## Approved decision 9 — No retention job: rows are kept, per the soft-delete ADR

**The decision:** no retention or cleanup job. Notification rows are kept indefinitely. The
90-day figure is a **query window** feeding `window_total`, never a deletion policy.

**Why deletion was never actually on the table:** [[ADR-0004-soft-delete-only]] forbids hard
deletes system-wide and enforces it at the infrastructure level — the database write user is
granted only `INSERT`, `UPDATE` and `SELECT`, never `DELETE`. So a hard delete is not a design
choice that was rejected; it is rejected by Postgres permissions even in raw SQL. That same ADR
already accepts the consequence in its own words: storage grows over time.

**Why no soft-delete job either:** marking `deletedAt` after 90 days is a permitted `UPDATE`, but
it frees no space — it would only hide rows the `GET` already excludes (newest 50, and
`window_total` scoped to 90 days). It would add a scheduled job to accomplish essentially nothing.
Note that none of the four existing tables in the Users schema (`users`, `users_cognito_data`,
`users_cognito_events`, and now `notifications`) has a purge job; adding one only for
notifications would treat them as special with nothing to distinguish them. Scale supports this:
notifications accrue at roughly one per order-status transition (five per order), so an active
user generates tens per year, not millions.

**Rejected alternatives**, recorded with the reason each was turned down:

- A scheduled soft-delete job — the patterns exist in this repo (a `setInterval` poller as in
  `services/users/src/shared/metrics/business-metrics.ts`, or an EventBridge rule as at
  `infra/environments/local/main.tf:456`) — but it buys no space, per the paragraph above.
- Archival to cold storage before soft-deleting — the only option that genuinely shrinks the
  table, and the only one needing new infrastructure: a bucket, a process, a format.
- Postgres range partitioning with `DETACH PARTITION` — ADR-compatible and it does retire data
  without `DELETE`, but heavy machinery for a slow-growing table.

If volume ever genuinely becomes a problem, the natural next step is partitioning, not a
soft-delete job.

**One clarification to record explicitly, because it is easy to get backwards:** the 90-day
window bounds `window_total` **only**. The list query returns the newest 50 with no date bound.
This is load-bearing for the design — the `Notifications — All` frame (`v7j7HT`) shows a
`WELCOME` notification dated "Jun 12" in its EARLIER group, which a date-filtered list would hide.

## Approved decision 10 — Toast auto-dismiss: 7 seconds, pausable

The user's instruction was "long enough to be read by a person." Recording the reasoning that
turns that into an implementable number, because a bare "7s" with no rationale invites someone to
change it arbitrarily: these notifications carry a 3-5 word title and a 10-14 word body (e.g.
`ORD-3MRAI-10482 · Handed to the carrier and on its way to you.`), which is roughly 4 seconds of
reading at a normal rate, plus the time to notice something appeared in a corner. Accessibility
guidance for auto-dismissing messages puts the floor around 5 seconds, and common design-system
guidance for toasts carrying an action is 4-10 seconds. **7 seconds** sits inside that band with
margin for the notice-it delay.

Three rules that make the intent hold in the non-ideal cases, all in scope:

- **The timer pauses on hover and on focus-within.** This is what stops the toast vanishing
  exactly as the user reaches for "View order."
- **A toast reached by keyboard navigation does not auto-dismiss** while it holds focus — the
  accessible form of the same rule.
- **Toasts queue rather than stacking without bound**, so several status transitions in a row
  cannot cover the screen.

The 7 seconds and the `Progress Fill` bar in the `jYz4h` component are the same thing: the bar
**is** the visible timer, so the countdown is legible to the user instead of the toast disappearing
unannounced. The bar's animation duration must therefore be driven by the same constant as the
dismiss timer — two independent values would drift and the bar would lie.

Dismiss timing is a **client-side concern only**: nothing about it reaches the API or the store.
The `Dismiss` link and `Close Button` in the frame dismiss the toast without marking the
notification read — dismissing a toast is not reading the notification, and the unread dot
survives in the panel.

## Scope

In scope: SNS fan-out + Floci POC; three producers switched to SNS; the Users table, consumer,
three endpoints, and WS push; IAM/env wiring for Users; and the web surface — WebSocket client
service with reconnection, `NotificationItem`, `NotificationsPanel`, `ToastNotification` (with its
progress bar), the All screen on desktop and mobile, NgRx state, and the two design-token gaps.
`apps/web/src` has **no** WebSocket code today (zero references to `wss://`), so connecting the
web to the socket is part of this work.

Out of scope: pagination (explicitly declined); notifications for `AUTH_OTP_REQUESTED`,
`PASSWORD_RESET_REQUESTED`; any change to the pipeline's existing tracking push.

**Corrected 2026-09-10 — `ORDER_CREATED` is in scope and subscribed.** The original scope
statement said Orders originates no notification and `ORDER_CREATED` stays unsubscribed from the
notifications queue, on the theory that "order confirmed" was served by the tracking `PLACED`
variant. That theory is decision 2's plan-time verification, and it failed: `PLACED` is never
emitted by any Tracking code path, so the tracking-only design would never have delivered an
"order placed" notification at all. `ORDER_CREATED` is therefore **in scope**, admitted by the SNS
filter policy (decision 2), and is the real trigger for the `PLACED` copy variant (see
[Design source](#design-source--the-pen-frames-read-live-over-the-pencil-mcp-not-from-an-html-export)).
`AUTH_OTP_REQUESTED` and `PASSWORD_RESET_REQUESTED` remain out of scope, unchanged.

**Tracking is NOT modified by this design.** No new publisher is added to
`create_tracking.go`, `PLACED` continues to be emitted by no code path, and the existing E2E
CONTRACT in `e2e/tests/gateway/realtime-tracking.spec.ts` — four transition messages, `PLACED`
explicitly absent — remains true and must not be changed by this work.

**Email behaviour, stated explicitly so nobody re-enables it during implementation:** the
pipeline's `tracking-status-changed-placed` template (and its `PLACED` entry in
`TEMPLATE_BY_STATUS`) stays unused, because `PLACED` is still never emitted as a tracking status —
enabling it would fire a duplicate "order confirmed" email alongside the one `ORDER_CREATED`
already sends (see decision 2). `ORDER_CREATED`'s existing "Order confirmed" email
(`functions/events-pipeline/src/handlers/order-created.ts`) is the only confirmation email and is
unchanged by this design. The in-app notification this spec adds does not add or remove any
email.

## Testing

Per [[testing]] and the CLAUDE.md three-layer rule, every new endpoint needs all three layers:
unit/integration, internal E2E (direct service URL), and **gateway E2E with a real Cognito JWT**.

The three new routes need adding to the API Gateway route map
(`infra/modules/api-gateway/main.tf`) **and** an nginx `location` block
(`infra/modules/compute/nginx/nginx.conf`) — a new top-level path without one falls through to
`location /` and silently reaches Users' default handling. A gateway 404 carrying
`{"message":"Not Found"}` means the request never reached the service; a 401 after the fix is the
good answer, since it proves the route resolves and reached the authorizer.

WebSocket delivery of `NOTIFICATION_CREATED` needs a gateway E2E using the existing
`e2e/support/ws-client.ts` harness (the same collector introduced for
[[2026-08-05-realtime-tracking-events-websocket-design]]). Assertions must print **what** arrived,
not just how many — a count-only assertion cannot distinguish a real drop from a wrong
expectation, as documented in that design's own debugging lesson
([Debugging lesson — a count-only assertion hides which system is wrong](2026-08-05-realtime-tracking-events-websocket-design.md#debugging-lesson--a-count-only-assertion-hides-which-system-is-wrong)).

## Observability

Per [[logging-context]]: flow logs use `app_event` (`notification_created`,
`notifications_marked_read`, `notification_push_failed`) with `reason` on failures; unknown
fields omitted, never null; never log a plaintext email. The consumer continues the trace from
the `traceparent` attribute, per [[ADR-0019-distributed-tracing-opentelemetry]]. The WS push gets
a manual PRODUCER span, as the pipeline's publisher does.

## Related

- [[users-service-design]] — owns the new `Notification` model, the three endpoints, the
  `sqs-consumer` plugin, and the WebSocket push this design adds.
- [[events-pipeline-design]] — the existing SQS-consuming Lambda and its three producers; this
  design changes their transport (SNS) but not their envelope or handler logic.
- [[terraform-modules]] — gains the SNS topic and the notifications SQS queue/subscription; no
  new Lambda-owning module, since the consumer lives inside Users.
- [[testing]] — the three-layer convention this design's new endpoints and WebSocket push must
  satisfy.
- [[logging-context]] — governs what the consumer and the WS push may log.
- [[2026-08-17-web-app-foundation-design]] — the Angular/NgRx/Tailwind foundation this design's
  web surface (panel, toasts, All screen, WebSocket client) builds on.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the existing WebSocket channel,
  connections table, and management-API pattern this design's push reuses.
- [[user-id-vs-cognito-sub-ownership-key]] — the ownership-key trap this design's Postgres-native
  `user_id` key sidesteps.
- [[soft-delete]] / [[ADR-0004-soft-delete-only]] — the soft-delete convention `Notification`
  follows.
- [[audit-fields]] — the six audit columns `Notification` carries.
- [[nano-id]] — the `ntf_`-prefixed id scheme for `Notification.id`.
- [[env-files]] — how `WS_MANAGEMENT_ENDPOINT` and the new SNS/SQS identifiers reach Users as
  generated env vars, never hardcoded.
- [[ADR-0017-floci-local]] — the local-emulator posture (verify, don't assume AWS-equivalence)
  governing the mandatory SNS-on-Floci POC.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the tracing backend the consumer's continued
  trace and the WS push's PRODUCER span report to.
- [[pencil-design-extraction]] — the method used to read the `.pen` frames and the convention for
  reporting design-token gaps upstream instead of hand-editing styles.
- [[doc-propagation]] — the convention this spec's `propagates-to:` frontmatter satisfies.
