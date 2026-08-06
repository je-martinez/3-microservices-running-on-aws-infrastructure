---
title: Tightened schemas across a producer/consumer boundary need producer-first deploys
type: lesson
area: events-pipeline
status: active
created: 2026-08-06
updated: 2026-08-06
tags:
  - type/lesson
  - area/events-pipeline
  - area/orders
  - area/tracking
  - area/users
  - status/active
  - severity/high
related:
  - "[[2026-08-05-email-payload-enrichment-design]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[floci-rds-apigw-limits]]"
---

# Tightened schemas across a producer/consumer boundary need producer-first deploys

## What happened

Shipping the redesigned email templates
([[2026-08-05-email-payload-enrichment-design]]) required enriching four SQS payloads
(Users, Orders, Tracking, a Cognito Lambda) so the new receipts, timelines,
and account summaries had data to render. The work landed in three commits:
producers first, then the pipeline's Zod schemas widened to **require** the
new fields, then the templates. Every test suite was green throughout — 115
Orders, 554 Tracking, 259 Users, 189 pipeline.

In the running local stack, two failures showed up that no suite caught:
emails silently stopped being delivered, and separately, delivered emails
were still the old unbranded ones long after the rebrand had shipped. A third,
unrelated failure surfaced in the same session. All three were invisible to
the tests.

1. **The deployed Lambda ran a stale bundle.** `dist/handler.js` predated the
   rebrand by two days. Unit and snapshot tests render both sides of the
   comparison from source, so they agree with each other while disagreeing
   with what is actually deployed. Only reading the real inbox revealed it.

2. **Tightened schemas rejected in-flight events.** Once the pipeline was
   redeployed with the new required fields, the running service containers
   were still older images that did not publish them yet. Every event failed
   validation as a `PermanentError`:
   `invalid ORDER_CREATED payload: invalid fields: full_name, subtotal_cents,
   tax_cents, shipping_cents, items`. A `PermanentError` is consumed, not
   retried — so those notifications were lost permanently instead of waiting
   for the producers to catch up. The deploy order that happened was
   consumer-first; it needed to be producer-first.

3. **A stale generated Prisma client, hidden by `.gitignore`.**
   `services/users/Dockerfile` generated the Prisma client in its `deps`
   stage, then `COPY services/users/src ./src` overwrote it with whatever the
   host had on disk. `src/generated/` is gitignored, so CI and fresh clones
   never saw the problem (nothing to copy over), while a developer machine
   with an older client got a build failing on `authType` — a column that
   *is* in `schema.prisma`. Fixed by generating the client after the copy, so
   it is a pure function of the schema rather than of build order.

## Why this happens

A required field added to a consumer's schema is a breaking change with a
deploy order, and CI can't see deploy order — it only sees the final state
of each side, both built from the same commit. Widening a schema to require
a field and adding that field to every producer is one logical change, but it
is not one atomic deploy: for however long the rollout takes, some producer
instances are still on the old image while the consumer is already on the
new one.

Whether that window is survivable depends entirely on how the mismatch is
classified. `PermanentError` says "this will never succeed, stop retrying" —
correct for a genuinely malformed payload, wrong for "the producer hasn't
redeployed yet." Skew looks identical to corruption from the schema's point
of view; only the deploy timeline tells them apart, and the timeline isn't
something a Zod schema can consult.

Tests rendering from source share the same blind spot for a different
reason: `dist/handler.js` and the snapshot test both start from the same
`.ts` source, so a stale build artifact is invisible to any suite that never
looks at the artifact. And the Prisma case shows that even "the schema is the
source of truth" can be undermined by build-stage ordering silently
reintroducing a stale file that gitignore keeps out of every other view of
the repo (CI, fresh clone).

## The fix / takeaway

- **Deploy producers before a consumer that now requires their new field.**
  Or, if order can't be guaranteed, widen the consumer to accept-but-not-require
  first, ship it, then tighten to required once every producer is confirmed
  current. Making a field required in the same change that starts adding it
  to producers assumes an atomic rollout that multi-service deploys don't
  give you.
- **Ask, per field, whether "the producer hasn't caught up yet" is really
  unfixable-by-retry before classifying it `PermanentError`.** That
  classification is what decides whether skew during a rollout is survivable
  or a silent, permanent loss.
- **Tests that render both sides from source cannot detect a stale
  deployment.** At least one check has to assert against the real artifact —
  here, an E2E that reads the actual delivered email out of Mailpit. That
  spec caught the stale bundle immediately; nothing source-based could have.
- **A build stage that generates into a path a later `COPY` overwrites will
  silently use the wrong artifact**, and a gitignored generated directory
  hides the discrepancy from CI and fresh clones alike, so the bug only shows
  up on machines with older local state. Generate after the copy, so the
  artifact is a function of the schema alone.

## Environment context — Floci re-apply behaviour

Local debugging was complicated by two pieces of Floci (local AWS emulator)
behaviour, worth recording as context rather than as the lesson itself:

- Floci recreates resources on re-apply, including the API Gateway id, so
  `make env-file` must be re-run before any E2E check after a Terraform
  re-apply or the tests hit a stale gateway URL.
- `terraform apply -target` did **not** repackage the Lambda zip; only a full
  apply re-read the `archive_file` data source. Even then, Floci still
  required an explicit `aws lambda update-function-code` to actually pick up
  the new code — the redeploy was not automatic from the Terraform apply
  alone.

Both are local-emulator behaviour, not an AWS constraint — real API Gateway
and Lambda don't churn identifiers or require a manual `update-function-code`
nudge on every apply. See [[floci-rds-apigw-limits]] for the related,
previously-documented finding that a second `terraform apply` against a live
Floci environment is unreliable in general.

## Related

- [[2026-08-05-email-payload-enrichment-design]] — the spec whose rollout
  surfaced all three failures.
- [[events-pipeline-design]] — the Zod schema validation and
  `PermanentError`/`TransientError` classification this lesson is about.
- [[testing]] — the three-layer testing convention; this lesson is the
  concrete case for why an E2E against the real artifact (not just
  unit/snapshot from source) is required.
- [[floci-rds-apigw-limits]] — prior, related finding on Floci re-apply
  unreliability.
