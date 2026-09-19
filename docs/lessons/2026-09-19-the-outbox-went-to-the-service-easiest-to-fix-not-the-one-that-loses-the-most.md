---
title: "The outbox went to the service easiest to fix, not to the one whose lost event hurts most"
type: lesson
area: shared
status: active
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/lesson
  - area/shared
  - area/tracking
  - area/orders
  - area/users
  - status/active
  - severity/medium
related:
  - "[[2026-09-18-cqrs-dispatch-tracking-orders-design]]"
  - "[[2026-09-18-cqrs-dispatch-tracking-orders]]"
  - "[[cqrs]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[users-service-design]]"
  - "[[logging-context]]"
---

# The outbox went to the service easiest to fix, not to the one whose lost event hurts most

## Finding

Three services in this repo publish domain events to SNS. After the CQRS milestone's Phase 2,
exactly one of them — Tracking — has a transactional outbox. Tracking was selected first, and
the reason it was selected first was that it was the easiest place to build one correctly: Go
over `database/sql`, an explicit `*sql.Tx` already open at the publish point, and a library
whose "unmanaged" mode accepts precisely that transaction. No step of the selection asked
which service's lost event does the most damage.

Measured against that question, the order should have been close to reversed. The failure
semantics of all three publish paths, verified in code on 2026-09-19:

| Service | Event | On publish failure |
|---|---|---|
| Tracking (Go) | `TRACKING_STATUS_CHANGED` | Before the outbox: `PublishTrackingStatusChanged` "emits one transition and **NEVER returns an error**" (`internal/adapter/notify/status_changed.go`, at commit `526fb48`) — the caller could not observe the failure at all |
| Orders (.NET) | `ORDER_CREATED` | Caught and swallowed, `ERROR` log with `app_event=order_created_publish_failed`, event lost (`SnsEventPublisher.cs`) |
| Users (NestJS) | `USER_CREATED` (×2 call sites), `PASSWORD_RESET_REQUESTED` | Caught and swallowed, `ERROR` log with `*_publish_failed`, event lost (`shared/messaging/event-publisher.ts`) |

By impact, the ranking runs the other way:

- **Users' `PASSWORD_RESET_REQUESTED` is the worst.** The reset code row is persisted and the
  email never goes out, so the user is locked out of their own account with no recovery path
  in the product. The endpoint answers identically either way (deliberately — no account
  enumeration), which means the user cannot even tell that anything failed.
- **Orders' `ORDER_CREATED` is next.** A customer completed a purchase, stock was decremented,
  and no confirmation is emitted. The event carries the order's money figures, so the
  downstream consumer's view of a paid order simply never exists.
- **Tracking's status change is the least severe of the three** — not trivial, but least. The
  tracking state itself is committed and remains readable on demand through the service's read
  endpoints. What a lost event destroys is the *proactive* notification (the status email and
  the WebSocket push), not the system's record of the truth.

## The counterweight: the Tracking outbox is correct and should not be undone

This is a sequencing error, not a wasted-work error. Tracking's case for an outbox is real and
independently strong, for a reason that does not apply to the other two:

- **The loss is unobservable.** Orders and Users at least emit an `ERROR` log with a
  `*_publish_failed` `app_event`, which makes the loss alertable and backfillable per
  [[logging-context]]. Tracking's pre-outbox publisher returned no error to its caller by
  design, so the write path had nothing to log about.
- **Nobody is present to retry.** Tracking transitions are driven by the carrier webhook, not
  by a user action. A registration or a checkout has a human on the other end who will try
  again; a carrier callback does not come back a second time because our SNS call failed.

So the work was the right work. The defect is in the ordering, and the ordering was never
argued — it fell out of feasibility.

## The mechanism — a defensible proxy silently replaced the real criterion

Every individual decision here holds up on its own. "Start where the mechanism can be built
correctly" is genuinely good engineering advice: it de-risks a pattern before it is rolled out
to harder ground, and Tracking's open transaction made an honest outbox achievable without
inventing a transaction-sharing layer. Orders' and Users' swallow-and-log choices are likewise
well-reasoned and documented in the code — Orders' publish sits *inside* the transaction and
before the commit, so rethrowing would roll back a completed sale; Users' rethrow would report
a failure for a registration that succeeded, and the client's retry would then hit
`email_exists` (409) forever. Both services consciously chose **alertable over atomic**, which
is a legitimate trade when the alert actually exists.

The failure is that **"which is easiest to build correctly" stood in for "which failure hurts
most" without anyone noticing the substitution.** A proxy criterion is hardest to catch
precisely when it is defensible: there is no bad decision to point at in review, only a
missing one. Nothing in the spec or the plan states an impact ranking across the three
publishers, so there was no artifact against which the chosen order could read as wrong. This
is the same family as
[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — a requirement that is never
written down leaves no trace when it goes unmet, and the work that did happen is
self-consistent enough to pass review on its own terms.

A second contributor: the milestone's framing was *"add a bus, and an outbox"*, scoped by
[[2026-09-18-cqrs-dispatch-tracking-orders-design]] to the two services being refactored.
Users was out of scope for the CQRS work for unrelated reasons (it is being migrated to
NestJS separately), and "out of scope for the refactor" quietly became "not considered for the
durability question" — even though durability is a property of the publish path, not of which
dispatch mechanism the service happens to use.

## Gotcha found while building it: the poller's index is load-bearing for `SKIP LOCKED`

The claim in `internal/outbox/poller.go` is
`WHERE scheduled_at <= UTC_TIMESTAMP(3) ORDER BY created_at ASC LIMIT ? FOR UPDATE SKIP LOCKED`,
and the migration carries a composite index on `(scheduled_at, created_at)` specifically to
support it. That index is not a performance nicety:

> **InnoDB locks the rows a scan touches, not the rows the query returns.** Without the index,
> a second poller's `SKIP LOCKED` skips rows the first poller merely *examined* and did not
> claim, so a backlog drains one poller at a time while the mechanism looks like it is working
> correctly.

This is a concurrency mechanism that fails by silent serialization rather than by
double-publishing, which makes it invisible to the obvious test: two pollers, no duplicates,
green. Throughput is the only symptom.

## Also: the library could not be the poller, and the spec assumed it could

`oagudo/outbox` v1.0.1 was chosen for Tracking partly on the basis that it would supply the
polling mechanism. It does not. Its `Reader`'s claim is a plain `SELECT ... LIMIT n` with no
transaction and no row lock — a grep for `SKIP LOCKED` / `FOR UPDATE` across the module returns
zero matches — and its own README FAQ answers "What happens when multiple instances of my
service use the library?" with: make consumers idempotent, rely on broker deduplication, **or
run a single replica**. Tracking runs several tasks and feeds a consumer that sends customer
email, so "publishes every row once per instance" was never an acceptable outcome.

The library is therefore used for the **write side only**: `outbox.NewWriter(dbCtx).Unmanaged()`
and `Store(ctx, tx, msg)`, which takes the caller's `*sql.Tx` and does exactly what it
advertises. The claim, the locking, the backoff, and the delete are ours, in
`internal/outbox/poller.go`.

> [!warning] The approved spec is factually wrong on this point
> [[2026-09-18-cqrs-dispatch-tracking-orders-design]]'s D6 still presents the library as
> covering the polling mechanism. Correcting an approved spec is a separate decision from
> recording this lesson, so the correction is flagged rather than applied here.

## How to apply

- **Rank publish paths by blast radius before choosing where a durability mechanism lands, and
  write the ranking down.** The question is not "where can we build an outbox?" but "whose
  lost event costs the most, and what is the cheapest thing that makes that loss visible?" An
  unwritten ranking cannot be reviewed.
- **Treat "easiest to do correctly" as a tie-breaker, never as the ordering criterion.** It is
  the right way to choose between two comparably-risky targets, and the wrong way to choose
  which risk to address first. When feasibility is the only reason given for an order, that is
  the signal that the impact question was skipped rather than answered.
- **"Out of scope for this refactor" is not "out of scope for this risk."** Durability belongs
  to the publish path. A service excluded from a dispatch refactor for unrelated reasons still
  has to appear in the impact ranking, even if the conclusion is "not now".
- **`ERROR` + `*_failed` `app_event` is a real mitigation — audit that it exists before ranking
  a loss as acceptable.** The gap between Orders/Users and pre-outbox Tracking was not the
  severity of the event, it was whether anything downstream could ever know. A swallow with an
  alertable log is a deliberate trade per [[logging-context]]; a swallow with no error path at
  all is an invisible one.
- **"Nobody is present to retry" is a first-class severity input.** Webhook-driven and
  scheduler-driven writes have no human retry loop behind them, which raises a
  lower-consequence event above a higher-consequence one that a user will simply re-attempt.
- **When a library is chosen partly for a capability, verify that capability at source before
  the choice is recorded as a decision.** A README's feature list and its FAQ can describe
  different products; the FAQ answer here ("or run a single replica") was the operative fact
  and it was one grep away.

## Related

- [[2026-09-18-cqrs-dispatch-tracking-orders-design]] — the design spec whose D6 chose
  `oagudo/outbox` for Tracking and sequenced the outbox work; its D6 needs the correction
  flagged above, and it carries no impact ranking across the three publishers.
- [[2026-09-18-cqrs-dispatch-tracking-orders]] — the execution plan that sequenced Phase 2, and
  the artifact where the ranking should have appeared as task order.
- [[cqrs]] — the pattern note the outbox and the poller belong to; the poller's `CONTRACT:`
  comments reference it.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — the same family of
  failure: an unmet requirement that was never written down leaves no trace, and the shipped
  work passes review on its own terms.
- [[tracking-service-design]] — the service that received the outbox, and whose transitions are
  carrier-webhook-driven with no human retry.
- [[orders-service-design]] — `ORDER_CREATED` publishes inside the transaction before the
  commit and swallows deliberately; second in the impact ranking.
- [[users-service-design]] — `PASSWORD_RESET_REQUESTED` is the highest-impact loss of the three
  and has no outbox; Users was out of scope for the CQRS milestone.
- [[logging-context]] — the `*_failed` `app_event` convention that makes Orders' and Users'
  swallowed publishes alertable, and which pre-outbox Tracking had no path to use.
