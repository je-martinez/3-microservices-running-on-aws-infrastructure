---
title: "Floci SNS fan-out support probe"
type: lesson
area: infra
status: active
created: 2026-09-10
updated: 2026-09-10
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/low
related:
  - "[[2026-09-10-in-app-notifications-design]]"
  - "[[ADR-0017-floci-local]]"
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
---

# Floci SNS fan-out support probe

Empirical probe of Floci's SNS support — topic creation, fan-out to multiple SQS queues, raw
message delivery, and `MessageAttributes`-based filter policies — run 2026-09-10 as the **blocking
Phase 0** of [[2026-09-10-in-app-notifications-design]], against a live `3mrai-floci-1` container
(`Up 2 days (healthy)`). Recorded so future SNS work on this repo doesn't re-derive it, and so the
in-app-notifications design is not accidentally shaped around an untested assumption.

## Headline verdict

**Outcome 1 of the three the plan enumerated: all four assertions hold, and the design stands
UNCHANGED.** Fan-out works, raw message delivery works, `MessageAttributes` survive, and the
filter policy genuinely filters. Neither fallback was triggered: Phase 2 (the three producers —
Users, Orders, Tracking — switching from `SendMessage` to SNS `Publish`) proceeds as designed, and
Phase 1 keeps its `filter_policy` argument on the notifications subscription.

> [!important] SNS on Floci is real, not stubbed
> This was not a foregone conclusion — Floci's community edition has historically been missing or
> incomplete on services this repo depends on (see [[floci-sqs-lambda-docdb-support]]'s DocumentDB
> findings, and [[floci-rds-apigw-limits]]'s API Gateway v2 path-forwarding gap). SNS turned out to
> be fully present and correctly behaved end to end.

## What was probed and what answered

### 1. Environment

Before the POC, `aws --endpoint-url http://localhost:4566 sns list-topics` returned
`{"Topics": []}` — SNS answers on this Floci build; it is not an unknown service (the plan's own
Task 0.1 treated `UnknownOperationException`/`InvalidAction` here as the first possible finding,
and it did not occur).

### 2. Terraform apply

Throwaway root `infra/poc/sns-fanout/main.tf`, outside `infra/environments/` (AWS provider
`~> 5.31`): one `aws_sns_topic`, two `aws_sqs_queue`, two `aws_sns_topic_subscription` (both
`raw_message_delivery = true`, one with `filter_policy_scope = "MessageAttributes"` and a
`filter_policy` on `type`), two `aws_sqs_queue_policy`.

Result: `Apply complete! Resources: 7 added, 0 changed, 0 destroyed.` No provider errors, no
unsupported-argument errors. Queues took ~25s each to create; the topic and both subscriptions
were instant.

### 3. Subscription attribute read-back — the check that separates "accepted" from "honoured"

`sns get-subscription-attributes` on both subscriptions:

- **Both** reported `"RawMessageDelivery": "true"`.
- **Exactly one** reported
  `"FilterPolicy": "{\"type\":[\"USER_CREATED\",\"ORDER_CREATED\",\"TRACKING_STATUS_CHANGED\"]}"`
  with `"FilterPolicyScope": "MessageAttributes"`; the other reported `FilterPolicy: null`, as
  intended.

> [!warning] The plan flagged this as its highest-value finding — and it did NOT occur
> A clean apply reporting `Raw: null` back would have been the *silent* version of a fatal
> failure: Terraform accepting the argument while Floci ignores it. That did not happen. **Keep
> this read-back as the standard check for any future SNS work on Floci** — a `terraform apply`
> exiting 0 only proves the argument was accepted, never that it was honoured.

### 4. The Python probe (`verify_fanout.py`), run twice from the repo venv

Published two envelopes of the real shape to the topic — one `USER_CREATED` (admitted by the
filter) and one `PASSWORD_RESET_REQUESTED` (deliberately chosen over an admitted type like
`ORDER_CREATED`, since probing with an admitted type would prove nothing about filtering) — then
drained both queues. Results were **identical on both runs**:

- Unfiltered queue received **2** messages: `USER_CREATED` and `PASSWORD_RESET_REQUESTED`.
- Filtered queue received **1**: `USER_CREATED` only.
- Body fidelity held **byte for byte** against the published string, on both bodies — raw delivery
  is real, not merely reported.
- `MessageAttributes` `type`, `source`, and **`traceparent`** all survived on every delivered
  message. The `traceparent` case is load-bearing: it is what keeps distributed tracing intact
  across the topic (see [[ADR-0019-distributed-tracing-opentelemetry]]).
- Verdict line printed both times: `PASSED: fan-out, raw body fidelity, attributes and filtering
  all hold.` Exit code 0.
- **Stability across two runs was a deliberate requirement**, not a formality — Floci behaviour
  has been observed to expire between versions elsewhere in this repo (see
  [[floci-vs-ministack-spike-findings]] for the pattern), so a single green run does not earn
  trust on its own.

### 5. In-network reachability

Users publishes from inside `3mrai_3mrai-network` at `http://floci:4566`, not from the host, and
Floci has a documented history of a service answering on one route but not the other (see
[[nginx-njs-x-user-id-injection]] for the general pattern, where Floci's HTTP API Gateway silently
fails one class of request while another route works fine). An `amazon/aws-cli` container on
that network published successfully (returned a `MessageId`). Going one step beyond the plan's own
requirement — a `MessageId` only proves the publish call was accepted, not that anything was
delivered — a follow-up drain confirmed the in-network message arrived in **both** queues with its
body (`{"probe":"in-network"}`) and its `type` attribute intact. The in-network path is therefore
verified end to end, not just at the publish call.

## Re-probe before trusting this note

Floci capability findings in this repo have been observed to expire across versions before (see
[[floci-vs-ministack-spike-findings]]), so a future reader should re-probe rather than trust this
note indefinitely. The cheapest re-probe is the subscription attribute read-back in point 3 above:
run it after any Floci version bump or `make clean`. **If `RawMessageDelivery` ever reads back as
anything other than `"true"` after a clean apply, the events-pipeline's `EnvelopeSchema` will
receive an SNS-wrapped envelope instead of the domain envelope, and all three existing handlers
break silently** — this is the exact failure mode the `main.tf` CONTRACT comment in
`infra/poc/sns-fanout/main.tf` (deleted with the rest of the POC, but reproducible from this note)
guarded against.

## Probe hygiene

The throwaway Terraform root and the Python probe were destroyed and deleted at the end of the
phase — this note is the phase's only durable artefact.

## Related

- [[2026-09-10-in-app-notifications-design]] — the design this probe unblocks; Phase 0 of its
  implementation plan.
- [[ADR-0017-floci-local]] — why this repo runs Floci at all, and its known-limits baseline.
- [[floci-sqs-lambda-docdb-support]] — the companion probe for SQS/Lambda/DocumentDB from the
  events-pipeline milestone; same "empirically verify before designing around it" method.
- [[floci-rds-apigw-limits]] — the companion probe for RDS + the HTTP API Gateway, cited here for
  its API Gateway v2 path-forwarding gap as another example of a partially-real Floci service.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the prior blocking POC in this repo's
  history (WebSocket API Gateway + DynamoDB), same throwaway-POC-outside-Terraform pattern.
- [[nginx-njs-x-user-id-injection]] — the general pattern of a Floci route behaving inconsistently
  depending on how it's reached, referenced for the in-network reachability check.
- [[floci-vs-ministack-spike-findings]] — prior evidence that Floci capability findings can expire
  across versions, the reason this note carries a re-probe instruction.
