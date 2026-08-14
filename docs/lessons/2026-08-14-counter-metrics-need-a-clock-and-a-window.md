---
title: Counter Metrics Need a Clock and a Window
type: lesson
area: shared
status: active
created: 2026-08-14
updated: 2026-08-14
tags:
  - area/shared
  - type/lesson
  - severity/high
related:
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[logging-context]]"
  - "[[openobserve-runbook]]"
---

# Counter Metrics Need a Clock and a Window

All findings below were verified empirically in one session against the local OpenObserve
dashboards and the events-pipeline Lambda.

## Finding 1 — A `metric` card over a COUNTER needs both a clock AND a window

OpenObserve's `metric` panel renders the **last point** of a series. That is correct for a
gauge (`users_total`, `orders_total`), where the newest value IS the answer. It is wrong for a
counter. With no point in the selected range, the panel throws
`Cannot read properties of undefined (reading 'values')` instead of rendering `0` — so the
card breaks precisely when nothing happened, making "no errors occurred" and "the exporter is
down" indistinguishable.

First attempted fix: seed the counters at `0` on each tick. It stopped the error but
introduced a **worse** bug — the freshest point became a seeded zero, so every counter card
read `0` in every range and stopped responding to the time picker. Measured:
`users_registered_total` over 2h had 118 points, only 10 non-zero, and the last 8 were all
zeros. The card stopped erroring and started lying.

The complete fix needs **both** halves:

1. Seed on a fixed clock so the series always has points.
2. Aggregate over a window instead of sampling the last point:
   `max by (dimensions_service) (sum_over_time(<metric>[24h]))`.

Use `max by(...)`, never `sum by(...)` — the collector stamps each scrape with its own
`start_time`, so one logical series exists many times over and `sum()` adds the duplicates
together. This is the same reason services publish a pre-summed `ALL` series.

## Finding 2 — Seeding from inside the event path cannot work; a Lambda needs an external clock

The events-pipeline seeded `emails_sent_total` / `emails_failed_total` at the top of every SQS
batch. That path only runs when mail is **already** flowing — exactly when the zeros are not
needed — so it published nothing during the quiet windows it was meant to cover. Measured:
`emails_sent_total` had **zero** points over 6 hours while `users_total` (a real periodic loop
in a long-running service) had continuous coverage in every window.

Every other service hosts its metrics poller in a long-running process. A Lambda has none —
it exists only while processing a message — so the clock must come from outside. Fixed with an
EventBridge rule `rate(1 minute)` (EventBridge's floor) targeting the Lambda with a constant
input `{"detail-type":"3mrai.metrics.tick"}`; the handler branches on that and returns early
without touching DocumentDB. Verified after the fix: 10 datapoints in 10 minutes with no mail
traffic at all.

Important: the handler identifies the tick by `detail-type`, **not** by the absence of a
`Records` field. Matching on shape would also swallow a malformed SQS delivery and report
success on dropped mail. A test fixes that distinction.

Note the granularity mismatch this creates: services seed every 15s (local), the Lambda every
60s. Acceptable because the narrowest dashboard range is 5 minutes.

## Finding 3 — OpenObserve has no dashboard time-range variable

There is no `$__range` equivalent. Verified two ways: the PromQL endpoint rejects it
(`Execution error: unexpected character inside brackets: '$'`), and OpenObserve's variable
system documents only user-defined variable types (`query_values`, `custom`, `constant`,
`textbox`, `dynamic_filters`) with no built-in automatic time variable.

Consequence: a counter card's window is a literal in the query and **cannot** follow the
picker. The honest resolution is to name the window in the panel title
(`Registrations (24h)`, `Emails sent (24h)`) rather than let it silently disagree with the
selected range. Gauge cards are unaffected — they legitimately show current state.

## Finding 4 — An undeclared Terraform service endpoint goes to real AWS, and bootstrap still exits 0

The EventBridge rule failed during apply with `UnrecognizedClientException: The security token
included in the request is invalid` — which reads like a Floci auth problem but means the
request never reached Floci. `infra/environments/local/providers.tf` needs every service
declared in its `endpoints` block; the provider's service key is `events`, not `eventbridge`.
That file already carried a comment predicting this exact failure mode for `dynamodb`.

What made the cause identifiable: the same rule created fine via the AWS CLI, which reads
`AWS_ENDPOINT_URL`.

Operationally important: **`make bootstrap` exited 0 despite this apply error**, so its exit
code is not a reliable success signal — verify the resource exists
(`aws events list-rules`) rather than trusting the exit status.

## Related

- [[floci-vs-ministack-spike-findings]]
- [[logging-context]]
- [[openobserve-runbook]]
