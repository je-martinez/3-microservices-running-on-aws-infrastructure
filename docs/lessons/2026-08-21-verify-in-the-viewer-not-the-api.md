---
title: Verify in the Viewer, Not the API
type: lesson
area: shared
status: active
created: 2026-08-21
updated: 2026-08-21
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/high
related:
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[events-pipeline-design]]"
  - "[[openobserve-runbook]]"
  - "[[observability-telemetry-milestone]]"
---

# Verify in the Viewer, Not the API

Confirming that data reached a backend is not confirming the feature works. Verify in the
viewer a human actually opens, and say which one you checked.

Three separate claims of "this works" failed in one session, each verified against the wrong
surface.

## Finding 1 — Span events are the spec-correct primitive, and Jaeger still shows nothing at a glance

Phase markers (`message_received`, `handler_dispatched`, `handler_returned`) were added to
`process_record` as OpenTelemetry span events — the semantically correct primitive for an
instant in time, as opposed to a duration. They were verified present through Jaeger's own
query API and reported as working.

Jaeger's UI renders span events only behind expanding the span row and opening a details tab.
As phase markers meant to be visible in the waterfall at a glance, they marked nothing — the
data was there, the feature was not.

## Finding 2 — Re-verifying via a different API is still not verifying the UI

After the user pointed out Finding 1, the same events were checked again — this time via
OpenObserve's `_search` API, found intact in its `events` column, and presented in a
comparison table implying OpenObserve displayed them better than Jaeger. It doesn't:
OpenObserve's trace view does not surface span events at all. The user's reply named the
pattern directly:

> [!quote] User, verbatim
> ¿Porque me sigues preguntando de Jaeger si no es el punto aqui? En OpenObserve no se ven,
> sigue viendose igual.

Two failures stacked here: the second verification was still API-first rather than
viewer-first, and the response kept re-centering the tool (Jaeger) the user had already moved
past instead of answering about the tool (OpenObserve) they were actually asking about.

## Finding 3 — 56/56 spans returned by `_search` is not a working waterfall

The trace waterfall was called working because `_search` returned all 56 spans of a real
trace — proof the data was fully ingested. The UI does not build its waterfall from
`_search`; it calls its own endpoint, `/api/{org}/{stream}/traces/{id}/dag`, and that endpoint
was returning HTTP 400 for **every** trace. Root cause and fix (a `gen_ai_operation_name`
column OpenObserve's LLM-tracing feature expects that nothing in this repo emits) are recorded
in [[ADR-0019-distributed-tracing-opentelemetry]] — this note is about the verification
failure, not the bug itself.

## The pattern, in the user's words

> [!quote] User, verbatim
> muchas veces dices que algo ya esta y en open observe no funciona para nada.

Three rounds of rework and, more costly, eroded trust in every subsequent "this works" claim
for the rest of the session — despite no production behavior actually breaking. The cost here
is entirely in wasted verification cycles and a reporting habit that had to be corrected by the
user three times before it changed.

## How to apply

- **Before claiming something is visible, find the endpoint the frontend itself calls and call
  THAT.** The JS bundle is greppable — `/traces/{id}/dag` was found by grepping OpenObserve's
  `index-*.js` for `/api/` paths containing `traces`. An API endpoint chosen because it's
  convenient to query proves storage, not display; the frontend's own network calls are the
  only reliable proxy for what a human will see.
- **Name the viewer you verified in.** "It works" without naming where is the claim that
  failed here three times. "Verified in OpenObserve's trace waterfall (UI)" and "verified via
  `_search`" are different claims with different evidentiary weight — say which one was made.
- **When the user asks about tool A, answer about tool A.** Repeatedly framing answers around
  tool B (Jaeger, after the user had moved to OpenObserve) is the same underlying failure in
  conversational form, and it took the user saying so explicitly to stop.
- **A correct-by-the-spec choice that renders nowhere is still the wrong choice.** The phase
  markers were re-implemented as real spans (`phase persist`, `phase dispatch`) carrying
  duration, which both viewers draw natively in their waterfalls; the original span events were
  kept only as secondary, queryable detail rather than the primary signal.

## Related

- [[ADR-0019-distributed-tracing-opentelemetry]] — the `gen_ai_operation_name` root cause
  behind Finding 3's `/dag` 400, and the Jaeger-to-OpenObserve backend history this session's
  verification confusion played out against.
- [[logging-context]] — the shared conventions for what a span/log line must carry; the
  `phase persist`/`phase dispatch` spans that replaced the invisible events follow the same
  workflow-span pattern this note documents.
- [[events-pipeline-design]] — Observability — tracing spans section: the phase-span structure
  that resulted from Finding 1, and the span-events-as-secondary-detail decision from Finding 1.
- [[openobserve-runbook]] — the Traces section: the `gen_ai_operation_name` 400 from Finding 3,
  documented operationally (symptom, cause, fix) rather than as a verification post-mortem.
- [[observability-telemetry-milestone]] — the milestone this session's work belongs to.
