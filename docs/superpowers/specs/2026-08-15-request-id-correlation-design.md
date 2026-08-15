---
title: Cross-Service Request ID Correlation Design
type: spec
area: shared
status: draft
created: 2026-08-15
updated: 2026-08-15
tags:
  - type/spec
  - area/shared
  - status/draft
propagates-to:
  - "[[logging-context]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
related:
  - "[[logging-context]]"
  - "[[nano-id]]"
  - "[[events-pipeline-design]]"
  - "[[health-check-logging]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[testing]]"
---

# Cross-Service Request ID Correlation Design

## Goal

Give every logical request one identifier — `request_id` — that follows it across every service
and every hop it touches, so a single flow (an order placed, a delivery status changing, a
notification email being sent) can be reconstructed end to end from the log stream alone. This
spec is the design; propagation into the shared logging convention and each service's design note
happens per `propagates-to:` above.

## Why `trace_id` does not already solve this

3MRAI already has a cross-service correlation id: `trace_id`, populated by the OpenTelemetry SDK
per [[ADR-0019-distributed-tracing-opentelemetry]] and carried on every log line per
[[logging-context]]. Introducing a second id needs a reason stronger than "more correlation is
nice" — and the reason is that `trace_id` has a coverage gap exactly where cross-service
correlation is hardest to do any other way:

- **The events-pipeline Lambda carries no OTel SDK at all.** [[logging-context]] already records
  this as a known gap: zero `@opentelemetry/*` dependencies in
  `functions/events-pipeline/package.json`, no `OTEL_*` variables in `infra/modules/lambda/`,
  tracked as [JE-138](https://linear.app/je-martinez/issue/JE-138). Every log line the pipeline
  emits today is missing `trace_id`/`span_id`.
- **The realtime WebSocket Lambdas have no OTel SDK either.** Same gap, different runtime — a
  `$connect`/`$default`/`$disconnect` handler has no span to attach a `trace_id` to.

These are precisely the hops where reconstructing a flow end to end matters most — an order event
that fans out through SQS into an email, or a tracking status change that fans out into a
WebSocket push — and precisely the hops where `trace_id` is absent. Waiting for JE-138 to fix this
by giving Lambdas a full OTel SDK is the wrong dependency to put in the critical path of
correlating logs today: an SDK is heavier to add correctly (see the three silent OTel
misconfigurations logged in [[logging-context]]) than a field that costs one header and one
context write. `request_id` has no SDK dependency and works identically in all four runtimes
(Node long-running services, .NET, Python, and Lambda) whether or not OTel is wired up.

**The two fields coexist and answer different questions.** `trace_id` is the tracing backend's
identifier — it drives Jaeger's waterfall view, span parenting, and duration breakdowns, and it is
only as complete as the OTel SDK's reach. `request_id` is a plain correlation value with no tracing
semantics — it exists purely so `grep`/a log query can pull every line belonging to one flow,
including the lines a tracing SDK never touched. Neither replaces the other; a service with full
OTel coverage still carries both fields on the same line.

## Format

`req_` + a 21-character Nano ID, following the `prefix_nanoid` shape [[nano-id]] already
establishes for entity ids (`ord_`, `usr_`, …). Two reasons to reuse rather than invent a new
shape:

- **Self-describing at a glance.** In a log line already carrying `trace_id`, `order_id`, and
  `user_id`, a bare-looking correlation value would be easy to mistake for one of those. `req_`
  makes it unambiguous on sight, the same benefit [[nano-id]] gives entity ids.
- **No new library or generation code.** Every service already has a Nano ID generator on the
  classpath for entity ids; producing a `req_` value is the same call with a different prefix, not
  a new dependency.

## Lifecycle — one rule, applied at every ingress

```
x-request-id present AND valid?  -> use it
otherwise                        -> generate req_<nanoid>
```

Applied once, at the outermost ingress point of each service (see the table below) — never
regenerated partway through a request. Every log line for the rest of that request/message reuses
the same value, which is the entire point: one id per logical flow, not one id per service call
within it.

## Validation — a security decision, not just a format check

An inbound `x-request-id` is only trusted if it matches:

```
^req_[A-Za-z0-9_-]{21}$
```

Anything else — wrong prefix, wrong length, unexpected characters — is **discarded**, and a fresh
`req_<nanoid>` is generated as if the header had never been sent.

This is deliberately a security control, not a cosmetic one. `x-request-id` is attacker-controlled
input on any public endpoint, and by design it ends up on **every log line the request produces**.
An unvalidated value would let a caller inject an oversized string, a control character, or
anything else into the log stream's most pervasively-present field — worse than injecting it into
one field on one line, because it contaminates the whole flow's worth of records at once, and
downstream log tooling (queries, dashboards, alerting rules) generally does not expect a
correlation-id field to carry adversarial content.

**Rejecting silently, rather than responding 400, is equally deliberate.** `x-request-id` is a
correlation aid, not a contract the caller must honor to get service. A caller that sends a
malformed value (a misconfigured client, a proxy that mangles headers, a curious tester) should
still get a normal response — with a *fresh* server-generated id — not a hard failure over a
header whose only job is convenience. A correlation header must never be able to fail an otherwise
valid request.

## Where it lives per service

No new machinery — each service attaches `request_id` to the same context mechanism it already
uses for `trace_id`/`user_id`/etc. per [[logging-context]]'s "Per-service mechanism" section, at
the ingress point that mechanism already has:

| Service | Store | Ingress point |
|---|---|---|
| users | `AsyncLocalStorage` (`shared/logging/log-context.ts`) | existing Fastify `onRequest` hook (`routes.ts:263`) |
| orders | `LogContextEnricher` + `IHttpContextAccessor` | `CallerContextMiddleware` |
| tracking | `contextvars` (`shared/logging/log_context.py`) | existing `LogContextMiddleware.__call__` (already calls `set_log_context`) |
| events-pipeline | `AsyncLocalStorage` (`shared/logging/log-context.ts`) | `envelopeContext()` per SQS record (`handler.ts:73`) |

Reusing the existing mechanism means no new store, no new middleware, and no new per-service
wiring to get wrong — only one more field written into a context that already exists and already
reaches the logger.

## Outbound propagation

Three hops, all of which already carry a mechanism for propagating context — this only adds one
more value to each:

- **orders → tracking** (HTTP): `x-request-id` header, set alongside orders' existing outbound
  headers in `TrackingHttpClient`.
- **tracking → users** (gRPC): `x-request-id` metadata entry, set alongside tracking's existing
  outbound metadata in `shared/grpc/users_client.py`.
- **orders/tracking → events-pipeline** (SQS): `request_id` as a **root field on the envelope**,
  next to the existing envelope fields (`event_id`, `type`, `author`, …).

## The envelope field is optional

`request_id` is added to the events-pipeline's Zod envelope schema as `.optional()` — never
required. The reason is operational, not stylistic: at deploy time there can be messages already
sitting on the SQS queue that were published before this field existed, carrying no `request_id`
at all. Making the field required would fail schema validation for those in-flight messages, and
per the pipeline's existing error-handling design that validation failure is a `PermanentError` —
the message is dead-lettered rather than retried, and the notification email it was meant to
trigger is silently lost. An optional field costs nothing for new messages and loses nothing for
old ones.

The consumer follows [[logging-context]]'s existing omitted-never-null rule: when `request_id` is
present on the envelope, it is put into context and logged; when absent, the field is **omitted**
from the log line entirely, never emitted as `request_id: null`. A null would read as "resolved to
nothing," which is a different and misleading claim from "this message predates the field."

## Explicitly out of scope

Recorded here so the next reader knows these were considered and deferred, not overlooked:

- **nginx does not generate the header.** Today nginx only forwards `x-user-id`, nothing else.
  Having nginx mint `x-request-id` (via `$request_id`) would extend coverage to 4xx responses that
  never reach a service at all — but it requires a Terraform change to the nginx module, and
  nginx's built-in `$request_id` is a 32-character hex value, not the `req_`+nanoid shape this
  design uses. Introducing a second format for the same logical field is worse than leaving the
  gap for now. Deferred.
- **The realtime WebSocket Lambdas.** A `$connect` invocation carries no `x-request-id` — API
  Gateway's WebSocket route doesn't forward arbitrary headers the way its HTTP/REST route does —
  so these Lambdas need a different propagation story (likely seeded from the connection id or a
  query-string parameter at `$connect` time) rather than reusing this design unchanged. Left for a
  follow-up.

## Testing

Per service, per [[testing]]'s expectation that behavior changes carry real coverage:

- A valid inbound `x-request-id` is honored (the same value appears on the resulting log lines).
- An invalid inbound `x-request-id` is discarded and a fresh `req_`-prefixed value is generated
  instead (request still succeeds — no 400).
- The field reaches the logger's actual output, not just the in-memory context.

Plus **one gateway E2E** — per [[testing]]'s three-layer requirement, exercised through the real
gateway with a Cognito JWT — that follows a single `request_id` across the orders → tracking hop:
issue a request through the gateway, confirm the same `request_id` appears in both services' logs
for that flow.

## Related

- [[logging-context]] — the shared per-line log context this field joins; also documents the
  events-pipeline's `trace_id` gap (JE-138) that motivates this design.
- [[nano-id]] — the `prefix_nanoid` convention this id's format reuses.
- [[events-pipeline-design]] — the envelope schema `request_id` is added to as an optional root
  field, and the `PermanentError`/dead-letter behavior that optionality avoids triggering.
- [[health-check-logging]] — the other place a probe/request's log presence is deliberately scoped;
  same shared-context surface this design adds a field to.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the `trace_id`/span backend this field
  deliberately does not replace.
- [[testing]] — the three-layer testing convention this spec's testing section follows.
