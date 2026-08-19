---
title: Distributed Tracing — Manual Spans Design
type: spec
area: shared
status: active
created: 2026-08-18
updated: 2026-08-19
tags:
  - type/spec
  - area/shared
  - status/active
  - issue/JE-138
  - issue/JE-152
  - issue/JE-153
  - issue/JE-154
  - issue/JE-155
  - issue/JE-156
  - issue/JE-157
  - issue/JE-158
  - issue/JE-159
  - issue/JE-160
  - issue/JE-161
propagates-to:
  - "[[logging-context]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[users-service-design]]"
  - "[[orders-service-design]]"
  - "[[tracking-service-design]]"
  - "[[events-pipeline-design]]"
related:
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[ADR-0018-observability-openobserve]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[2026-07-19-logging-context-and-tracing-design]]"
  - "[[testing]]"
  - "[[2026-07-12-prisma-lazy-promise-als]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-18-distributed-tracing-spans]]"
---

# Distributed Tracing — Manual Spans Design

## Status of this document

Validated with the user in a brainstorming session on 2026-08-18. This spec documents exactly
what was agreed — it does not add scope or invent decisions beyond what follows. Where a
decision is explicitly a limitation or a deferred item, it is marked as such rather than
smoothed over.

> [!info] Implemented and verified (2026-08-19) — 10/11 issues closed
> JE-138 and JE-152 through JE-160 are Done; only JE-161 (full-trace E2E, spec Decision 11)
> remains. Verified against a real Jaeger trace for `POST /v1/users/register` (54 spans) and the
> SQS/link hop for `events-queue process` -> `process_record`. Propagated into
> [[logging-context]], [[ADR-0019-distributed-tracing-opentelemetry]],
> [[users-service-design]], [[orders-service-design]], [[tracking-service-design]], and
> [[events-pipeline-design]] — see each note's Observability section for the per-service detail.

**Correction (2026-08-18):** Decision 5's diagram originally marked the events-pipeline Lambda's
internal spans (DocumentDB insert, SES send, WebSocket publish) as `auto-instr.`. This was found
to be factually impossible while writing the implementation plan
[[2026-08-18-distributed-tracing-spans]] — esbuild's single-file CJS bundling (verified in
`functions/events-pipeline/scripts/build.mjs`) inlines those SDK clients, leaving no module
boundary for OTel's auto-instrumentation to patch. The diagram and Decision 6 were corrected
in place to say manual spans, same pattern as [[ADR-0019-distributed-tracing-opentelemetry]]
already records about the OpenObserve choice evolving after initial design.

## Context — audited current state

Trace infrastructure already exists and is running:

- Collector `observability/otel-collector-config.yaml`: pipeline
  `traces: receivers:[otlp] processors:[batch] exporters:[otlp/jaeger]`. OTLP receiver on 4317
  (gRPC) and 4318 (HTTP). Exporter to `jaeger:4317`.
- Jaeger all-in-one 1.62.0, `docker-compose.yml:160-167`, UI on 16686, under
  `profiles: [observability]`.
- [[ADR-0019-distributed-tracing-opentelemetry]] already decided: logs → OpenObserve,
  traces → Jaeger.

### Instrumentation today, per service

- **users** (Fastify/TS): SDK in `services/users/src/shared/observability/tracing.ts:24-53`,
  loaded via `node --import` (`Dockerfile:118`) for ESM hoisting reasons.
  `getNodeAutoInstrumentations()` with only `fs` disabled. One manual span exists:
  `withGrpcServerSpan` in `src/shared/observability/grpc-tracing.ts:17,26`, used in
  `src/features/users/grpc/get-user-by-id.ts:18` — it exists because `ServerInterceptingCall`
  prevents `instrumentation-grpc` from creating the server span itself.
  **Prisma has NO spans** (the meta-package does not include `@prisma/instrumentation`).
- **orders** (.NET 10): SDK in `src/Orders.Api/Program.cs:41-59`, with AspNetCore + HttpClient +
  EFCore instrumentation. **ZERO manual spans** (`Activity` is only READ, in
  `Logging/LogContextEnricher.cs:34`). **SQS/AWS SDK is uninstrumented** (missing
  `OpenTelemetry.Instrumentation.AWS`); `Orders.Infrastructure/Messaging/SqsEventPublisher.cs`
  publishes with no span and no traceparent.
- **tracking** (FastAPI): zero-code via `opentelemetry-instrument` in `Dockerfile:153`.
  Instrumented: fastapi, sqlalchemy, grpc. **ZERO manual spans**. boto3 is uninstrumented.
  **Makes no outbound HTTP** (verified: 0 hits of httpx/requests/aiohttp under
  `services/tracking/src`; httpx is explicitly excluded from the runtime image, see
  `requirements-runtime.txt:6`).
- **functions/events-pipeline** (Lambda, Node): **ZERO `@opentelemetry/*` deps**, zero `OTEL_*`
  vars in `infra/modules/lambda/`. Documented in `src/handler.ts:51-56`. Tracked as JE-138.
- **functions/realtime-events** (WebSocket Lambdas): also uninstrumented.

### Propagation today (W3C traceparent) — the 3 synchronous hops already work

- orders → users (gRPC): injected via `AddHttpClientInstrumentation` (`Grpc.Net.Client` rides on
  `HttpClient`), `Program.cs:33-40`.
- users gRPC receiver: manual extraction in `src/shared/grpc/api-key-interceptor.ts:25-32`
  (`extractParentContext`), activated in `onReceiveHalfClose` at line 91. This was the JE-77 fix:
  activating in `onReceiveMetadata` left spans orphaned because grpc-js dispatches the handler on
  a later tick and the AsyncLocalStorage scope had already unwound by then — same trap family as
  the Prisma lazy-promise/ALS pitfall ([[2026-07-12-prisma-lazy-promise-als]]).
- orders → tracking (HTTP) and tracking → users (gRPC): work via auto-instrumentation.
- **SQS: BROKEN** — no publisher injects a traceparent, and the Lambda has no SDK at all.
- No `x-trace-id` header exists anywhere in the repo (0 hits).

No sampling at any layer (100%, `parentbased_always_on` default). The collector has no
`memory_limiter`.

## Decision 1 — reject a custom `x-trace-id` header

The user's initial proposal was to propagate a custom `x-trace-id` header. **Rejected.** It
duplicates what W3C `traceparent` already does in this repo, and it loses the parent's
`span_id` and the sampling flag — a remote span would join the trace but with no hierarchy,
flattening the exact cascade this design exists to measure. Recorded here because the reasoning
is worth keeping for the future, not because the option was close.

## Decision 2 — span pattern

**Rule: a new span is created when work crosses a process boundary (network, disk, queue) or
represents a business step with its own name. Nothing else — an internal helper does not get a
span.**

| Kind | Name | Kind (OTel `SpanKind`) |
|---|---|---|
| Workflow | `<flow>` | INTERNAL |
| DB | auto-instrumentation | CLIENT |
| External service call | auto-instrumentation | CLIENT |
| Queue publish | `<queue> publish` | PRODUCER |
| Queue consume | `<queue> process` | CONSUMER |

The workflow span carries the **same attributes already on today's flow log** (`app_event`,
`reason` on failure, `order_id`, `user_id`, …), so trace and logs tell the same story and
neither needs the other to be understood. On failure: `recordException()` +
`setStatus(ERROR)` with the same `reason` the log carries.

One helper per service so the pattern is never hand-copied: `withWorkflowSpan` (Users),
`IWorkflowTracer` (Orders), a decorator/context-manager (Tracking).

> [!danger] The span MUST close in a `finally`
> A span not closed on an exception path never reaches Jaeger — it does not show up as an
> error, it simply vanishes from the cascade, which is worse than not having it at all.

## Decision 3 — scope of workflow spans: the 11 flows with a full `app_event` triad

Criterion: flows that **already** have a `*_started` / `*_succeeded` / `*_failed` flow log
(same bar as the logging convention: "only flows with real diagnostic value").

- **Users (7):** register, login, change_password, otp_challenge, otp_verify,
  password_reset_requested, password_reset_confirm
- **Orders (1):** create_order
- **Tracking (3):** init_tracking, carrier_status_update, test_mode_progression

That is 7 + 1 + 3 — the per-service count is what governs, not a round total.

`*_publish_failed` and `metric_*` are **not** flows: they are error branches inside other
flows and stay as events on the parent span. `e2e_*` flows are excluded.

## Decision 4 — the SQS hop: traceparent in `MessageAttributes` + span links

- The 3 publishers (Users TS, Orders C#, Tracking Python) inject `traceparent` into SQS
  **`MessageAttributes`**, **not** into the envelope body. Reason: the envelope is a
  Zod-validated domain contract; putting transport concerns in it would contaminate the
  contract and force a schema version bump.
- **Verified in code, and it lowers the risk of this hop:** all 3 publishers already use
  `MessageAttributes` for `type` and `source` — see
  `services/orders/src/Orders.Infrastructure/Messaging/SqsEventPublisher.cs:153-156`,
  `services/tracking/src/shared/messaging/sqs_event_publisher.py:410`, and
  `services/users/src/shared/messaging/event-publisher.ts:172,258`. Adding `traceparent` is one
  more entry in a dictionary that already exists, not a new mechanism.
- The consumer uses **span links, not parent-child**. Reason: an SQS batch carries messages
  from **distinct** traces. Declaring a single parent would force picking one of N origins and
  lying about the rest. With links, `events-queue process` links to the N origin traces, and
  each record opens its own child span carrying its own link.
- **Honest limitation, documented on purpose:** in Jaeger, a link does **not** draw the
  Lambda's bar inside the origin trace's cascade as if it were a child — it appears as a
  navigable reference instead. That is the price of not faking hierarchy in a batch consumer.
  If a future consumer ever processes one message at a time, parent-child would become
  legitimate there.

## Decision 5 — events-pipeline: instrument the inside, not just the entry point

Closes JE-138. Span structure:

```
events-queue process (CONSUMER, links → N origin traces)
├── process_record (INTERNAL, link → origin trace)
│   ├── INSERT events (DocumentDB, CLIENT, manual)
│   ├── SES SendEmail (CLIENT, manual)
│   └── ws publish (PRODUCER, manual)
└── process_record (INTERNAL, link → another origin trace)
```

> [!warning] The Lambda's internal spans are manual, not auto-instrumented — by packaging necessity
> `functions/events-pipeline/scripts/build.mjs` bundles the handler with esbuild into a **single
> CJS file** (`bundle: true`, `format: "cjs"`, `target: "node20"`): the AWS SDK, `mongodb`, and
> `zod` are all **inlined**; `external` lists only mongodb's optional native/peer deps (kerberos,
> `@mongodb-js/zstd`, snappy, socks, aws4, `mongodb-client-encryption`, `gcp-metadata`), which stay
> absent and unused. The zip contains only the bundled file(s) — no `node_modules`, no
> `package.json`. `format: "cjs"` is not a style choice either: an ESM bundle loads fine under
> local Node but **fails on the real `nodejs20.x` runtime** with `ERR_REQUIRE_CYCLE_MODULE`
> (verified empirically — testing only in local Node would have produced a false pass).
>
> OTel auto-instrumentation works by patching a module at its `require`/resolution boundary when
> it loads. Once esbuild has inlined `@aws-sdk/client-ses`, `mongodb`, and
> `@aws-sdk/client-apigatewaymanagementapi` into one file, there is **no module boundary left to
> patch** — the packages never go through `require()` as separate modules. Registering
> `getNodeAutoInstrumentations()` in this Lambda would silently produce **zero** spans for
> DocumentDB, SES, and the WebSocket push, with no error — the same silent-failure shape the "OTel
> configuration belongs in the environment, not in code" discussion in [[logging-context]] already
> documents three times over. So the INSERT/SES/ws-publish spans in the diagram above are created
> **manually**, by necessity of the bundling strategy, not by style preference.
>
> **Alternatives considered and rejected:**
> - **(a) Mark the packages `external` in esbuild and ship them in `node_modules` beside the
>   zip.** Rejected — it inverts the entire reason the bundler exists. `build.mjs` documents this
>   exact trade-off already: an unbundled `dist/` with a generated `package.json` and a production
>   `pnpm install` into `dist/node_modules` was considered and rejected there, because it would
>   ship mongodb's whole dependency tree **and** create a second copy of the `imports` map that has
>   to be kept in sync by hand with the real one.
>   - **(b) The ADOT Lambda layer.** Rejected — same reasoning as Decision 7 of this spec: one
>   more layer to version, with uncertain behavior under Floci.
>   - **(c) Manual spans. Adopted.**

One span **per record**, not just per batch: that is the level where the link is meaningful and
where it becomes visible which message was expensive. Since each record already establishes its
own log context (`type`, `author_actor`, …), span and logs stay aligned with no extra work. The
per-record loop already exists (`handler.ts:266`, `for (const record of event.Records)`)
alongside `batchItemFailures` for partial failures, so the per-record span fits naturally into
that structure — a record that fails marks its own span `ERROR` without affecting the others.

> [!warning] Trap to document explicitly: `SqsRecord` drops unknown fields today
> `SqsRecord` in `functions/events-pipeline/src/handler.ts:16-19` declares **only** `messageId`
> and `body`. It must be widened to include `messageAttributes`, or the `traceparent` will
> arrive on the SQS message and be **silently ignored** — exactly the failure mode this repo has
> already suffered three times (see the "OTel configuration belongs in the environment, not in
> code" discussion in [[logging-context]]). This is a type definition that is easy to lose in
> implementation, so it is called out here rather than left as a footnote.

The **EventBridge tick** (rate 1 minute, metrics) enters as a **new trace with no link**: it
originates from a timer, so there is no origin trace to link to.

## Decision 6 — realtime-events: IN scope

The OTel SDK is added to all 4 entry points under `functions/realtime-events/src/`: `connect.ts`,
`disconnect.ts`, `default.ts`, and `authorizer.ts`. `default.ts` (inbound client messages) is a
real workflow step. For `connect.ts`, the concrete value is that its logs gain `trace_id` (they
have none today) and that authorizer latency becomes measurable. `authorizer.ts` is included
explicitly: it validates the JWT on `$connect`, and that is exactly where measuring latency has
the most diagnostic value — an authorizer that slows down is otherwise invisible in the trace.

> [!warning] Same bundling constraint as Decision 5, times four
> `functions/realtime-events/scripts/build.mjs` compiles the 4 entry points into **4 independent
> CJS bundles** (`bundle: true`, `format: "cjs"`, one `outfile` per entry point) — the same
> deliberate CJS choice as events-pipeline, for the same verified reason (an ESM bundle fails on
> `nodejs20.x` with `ERR_REQUIRE_CYCLE_MODULE`). Any internal call these handlers make into an
> inlined SDK client is therefore manual, not auto-instrumented, for the same reason as Decision 5.
> The shared tracing bootstrap module is **written once** but **inlined into each of the 4
> bundles separately** — there is no runtime shared across bundles, so there is no single place to
> centralize the flush. **Each handler must call its own `forceFlush()`** in its `finally` (see
> Decision 7); a flush added to only one entry point does not cover the other three.

> [!warning] Honest limitation, documented on purpose
> When events-pipeline publishes to a client via the API Gateway Management API, there is no way
> to propagate `traceparent` into the WebSocket frame without changing the message contract the
> frontend consumes. The create_order trace reaches events-pipeline's `ws publish` span and
> **ends there** — it does not join with the `$default` Lambda invocation for a later client
> message. Out of scope unless the frontend contract changes.

## Decision 7 — Lambda flush: `BatchSpanProcessor` + `forceFlush()` in a `finally`

Lambda freezes the process on return; buffered spans are either lost or arrive extremely late on
the next invocation. `SimpleSpanProcessor` was rejected (one HTTP request per span; with large
batches it adds latency), and the ADOT layer was rejected too (an extra layer to version, which
may not behave the same way under Floci). There is a cold-start cost to loading the SDK,
acceptable in an asynchronous pipeline, but a conscious trade-off — documented as such, not
hidden.

## Decision 8 — new auto-instrumentation

- **Prisma in Users:** add `@prisma/instrumentation`. Users is currently the only service whose
  DB does not appear in the cascade.
- **AWS SDK in Orders and Tracking:** `OpenTelemetry.Instrumentation.AWS` (Orders) and
  `opentelemetry-instrumentation-boto3sqs` (Tracking), so publishing to SQS produces a client
  span.
- **Explicitly EXCLUDED: HTTP client instrumentation in Tracking.** The user had originally
  selected it, but verification showed Tracking makes **no** outbound HTTP calls (only gRPC to
  Users, and boto3). Adding `instrumentation-httpx` would instrument a library that is not even
  in the runtime image. Recorded as a reasoned exclusion: if Tracking later calls a carrier over
  HTTP, add it then.

## Decision 9 — configuration: env vars, never code

Rule already established in [[logging-context]] (three silent failures came from skipping it).
The new Lambda runtimes receive their `OTEL_*` vars from `infra/modules/lambda/`, which today
has none.

## Decision 10 — collector and operation

- Add `memory_limiter` to the traces pipeline, **ahead of `batch`** (order matters — limit
  before accumulating).
- **No sampling** — 100% of traces. Document how to turn on `tail_sampling` when volume
  requires it.
- **Operational trap:** the collector and Jaeger sit behind `profiles: [observability]`, so a
  plain `docker compose up` does not start them and exports fail silently (connection refused).
  The default startup behavior is **not** changed by this design, but a check is added to
  `make doctor` that warns when a service has `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at a
  collector that is not running.

## Decision 11 — verification

The repo has recorded two false PASSes from measurement windows that were too tight
([[2026-07-19-logging-context-and-tracing-design]] / repo history). Verification for this design
follows the same lesson:

- **Unit, per service:** the helper closes the span on failure (the `finally`), sets
  `status=ERROR`, and the `reason` matches the log's `reason`.
- **Context extraction:** a test of the traceparent in `MessageAttributes` in all 3 publishers,
  and of the link in the consumer.
- **Full-trace E2E:** run create_order through the gateway with a real Cognito JWT, wait for
  Jaeger to index, and query the Jaeger API asserting that **one single trace** contains the
  spans of all three services with the expected hierarchy. Query with margin over the export
  cycle, not a tight window.
- **JE-77 anti-regression:** explicitly assert the Users span has a parent (`refs != 0`) —
  exactly what failed before and what the unit test alone did not cover.

## On measuring time (brief conceptual note)

Duration is intrinsic to a span (the SDK records start/end time; closing the span **is** the
measurement). The value on top of the `duration_ms` already present in logs is
**decomposition**: not "create_order took 340ms" but where that time went. Three honest caveats:

- Nesting is not arithmetic: children running in parallel overlap and do not sum to the parent's
  duration. Parent minus Σchildren is the service's own time.
- A span measures wall-clock time, not CPU time: it includes event-loop / thread-pool wait.
  Correct for "what does the user experience," not for "how much CPU does this cost."
- On the SQS hop, publish→process subtraction includes queue wait time (can be seconds) — valid
  information, but it is **not** "how long the code took."

## Non-Goals

- **HTTP client instrumentation in Tracking** — no outbound HTTP exists today (Decision 8).
- **Propagating `traceparent` into the WebSocket frame** sent to the browser client — would
  require a frontend contract change (Decision 6).
- **Sampling** — stays at 100%; only the activation procedure for `tail_sampling` is documented
  for future use, not adopted now (Decision 10).
- **Changing the default `docker compose up` startup profile** — the collector and Jaeger stay
  behind `profiles: [observability]`; only a `make doctor` warning is added (Decision 10).

## Related

- [[ADR-0019-distributed-tracing-opentelemetry]]
- [[logging-context]]
- [[ADR-0018-observability-openobserve]]
- [[ADR-0003-grpc-inter-service]]
- [[2026-07-19-logging-context-and-tracing-design]]
- [[testing]]
- [[2026-07-12-prisma-lazy-promise-als]]
- [[events-pipeline-design]]
- [[2026-08-18-distributed-tracing-spans]] — implementation plan; found the Decision 5/6
  auto-instrumentation error while being written
