---
title: Health-check logging
type: convention
area: shared
status: active
created: 2026-08-15
updated: 2026-08-15
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[ADR-0018-observability-openobserve]]"
---

# Health-check logging

## The rule

A service's liveness/readiness probe (`GET /v1/health`) is **exempt** from the per-request
`request completed` log **while it succeeds (2xx)**. A probe that returns a non-2xx status — or
that produces no response status at all — **is logged**, exactly like any other request.

## Reasoning

### What forced it, measured not assumed

In Tracking, 353 of 368 log lines in one hour were `GET /v1/health -> 200` — 96% of the stream —
against 2 lines describing actual tracking work. The probe runs forever at a fixed interval, so
that share **grows** on an idle system: it is volume that scales with uptime, not with usage. Left
unexempted, the health-check line is not merely noisy, it is the dominant record in the stream by
construction.

### Why successes specifically carry nothing

A succeeding probe's log line is the one whose content is already known before it is written: the
container being up says it, and the duration is effectively a constant. A **failing** probe's line
carries the status and the latency that explain *why* it failed — which is precisely the case
worth keeping. The asymmetry between a 2xx and a non-2xx probe response is the whole basis for the
rule: one line is redundant with the fact the process is running, the other is the only signal
that something is wrong before a human or an alert notices.

### The objection this had to answer

Tracking's middleware originally argued, in writing, against any exemption: "a probe that starts
failing is worth seeing, and an exemption list is one more thing to keep correct." Both halves are
still true today. The rule keeps the first half — failures are logged, unconditionally — and
answers the second by scoping the exemption on **status**, not on a maintained list of routes to
suppress. There is exactly one condition to get right (2xx vs. not), not a list of routes that
needs to be kept in sync as endpoints are added or renamed. This is the objection being
**answered**, not overruled — it is why the rule has the shape it does.

### Scoped by status, not by suppressing the route

The anti-pattern this rule deliberately avoids is suppressing the health-check **route** outright.
Doing so would hide exactly the failure the original objection wanted to protect — a probe that
starts returning 500 would vanish from the log stream along with its 200s, which is worse than the
noise problem it would "solve." The exemption is conditional on the response being a success; nothing
about the route itself is special-cased.

## Per-service implementation

| Service | Mechanism |
|---|---|
| users | Fastify `onResponse` hook in `features/users/http/routes.ts`; guard on route + 2xx. |
| orders | `UseSerilogRequestLogging`'s `GetLevel` callback in `Program.cs` → `Verbose` for a succeeding probe (the service's minimum level is `Information`, so it is filtered before the sink; the record still exists if someone lowers the level). Route constant is `PublicRoutes.HealthRoute`. |
| tracking | `_log_request` in `shared/http/log_context_middleware.py`; early return on route + 2xx. |

Two implementation notes worth recording because they are easy to get wrong:

> [!warning] orders — `GetLevel` replaces Serilog's default level selection wholesale
> Assigning a `GetLevel` callback does not layer on top of Serilog's built-in level selection, it
> **replaces** it entirely — so the `5xx -> Error` arm has to be reproduced by hand inside the
> callback. Returning a flat `Information` for every non-probe request would silently **downgrade**
> every server error on the request log — a regression introduced by a change whose intent was only
> to reduce health-check noise.

> [!warning] tracking — a missing status is not a success
> The guard checks `status is not None` in addition to the 2xx range. A request that produced no
> response status at all — the 500 path that re-raises before `http.response.start` is ever sent —
> is not a success and must still be logged. Treating "no status" as implicitly exempt would drop
> exactly the failure case the rule exists to keep.

## Testing requirement

Each service pins the rule with a **pair** of tests: a succeeding probe emits no line, and a real
request still does. Testing only the exemption would let a change that silences the route
**entirely** pass — which is the outcome the original objection was right to guard against; the
pair is what keeps the exemption honest.

Tracking additionally covers the **failing** probe directly, since its middleware can be driven
with a purpose-built test app. Users and orders do not cover the failing-probe case directly,
because forcing their real health endpoint to fail would mean changing production code just to
suit a test — so coverage there is the pair above, not the full three cases. State this plainly
rather than implying uniform coverage across all three services.

## Related pitfall found during this work — Users' duplicate request log

While implementing this rule in Users, the service was found to be emitting **two** lines per
request, both with the message `request completed`: Fastify's built-in request log (carrying
`res.statusCode`, `responseTime`) and the service's own schema-aligned hook (carrying `http_route`,
`http_response_status_code`, `duration_ms`). Every request-rate figure computed from that message
was double the real count, and half the rows answered an `http_route` filter with nothing, because
only one of the two lines carried it. Fixed with `disableRequestLogging: true` on the Fastify
instance, leaving the schema-aligned hook as the sole source of the `request completed` line.

A service adopting this health-check exemption should check it is not also emitting the
framework's own built-in request log alongside its schema-aligned one — the two problems are
independent, but they were found together, and the duplicate would have doubled the noise this
convention is meant to reduce.

## Related

- [[logging-context]] — the parent convention for the shared log schema and per-service logging
  mechanism this health-check rule scopes.
- [[testing]] — the three-layer testing convention; the pair-of-tests requirement above follows
  its spirit of not letting a happy-path-only test pass for the wrong reason.
- [[ADR-0018-observability-openobserve]] — the backend this log stream feeds, and the original
  motivation for keeping it low-noise.
