---
title: CQRS Dispatch — Tracking and Orders Implementation Plan
type: plan
area: shared
status: draft
created: 2026-09-18
updated: 2026-09-19
tags:
  - type/plan
  - area/shared
  - status/draft
  - area/tracking
  - area/orders
  - milestone/cqrs-dispatch-all-services
  - phase/1
  - phase/2
propagates-to:
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[logging-context]]"
  - "[[testing]]"
related:
  - "[[2026-09-18-cqrs-dispatch-tracking-orders-design]]"
  - "[[cqrs-dispatch-all-services-milestone]]"
  - "[[2026-09-19-users-nestjs-migration]]"
  - "[[cqrs]]"
  - "[[dependency-injection]]"
  - "[[screaming-architecture]]"
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[logging-context]]"
  - "[[testing]]"
  - "[[ADR-0002-cqrs]]"
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]]"
  - "[[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]]"
  - "[[code-comments]]"
  - "[[git-workflow]]"
  - "[[phase-c-review-flow]]"
  - "[[doc-propagation]]"
---

# CQRS Dispatch — Tracking and Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Tracking (Go) and Orders (.NET) a uniform CQRS dispatch pipeline — `tracing -> app_event -> logging -> validation -> handler` — so the cross-cutting concerns each service repeats per handler today are applied once, then add a per-service transactional outbox to the two handlers that publish events. No handler's externally visible behavior changes.

**Architecture:** One shared **contract**, two native implementations, no shared code across languages (spec D1/D2). Tracking gets a hand-rolled generic `Handler[Q,R]` / `Middleware[Q,R]` / `Wrap` in `internal/bus/` with manual wiring in the composition root (spec D5/Go); Orders gets Wolverine 6.39.0 with convention-based handler discovery and `WolverineFx.Http` opted in **per endpoint**, coexisting with the existing `MapGet`/`MapPost` delegates (spec D5/.NET). Phase 1 is pure in-memory dispatch and touches no database; Phase 2 adds one outbox table per service, in that service's own database, plus a poller component (spec D6/D7).

**Tech Stack:** Tracking — Go, Gin, sqlc, golang-migrate, OpenTelemetry Go SDK, `oagudo/outbox` v1.0.1 (Phase 2). Orders — .NET 10, EF Core with Pomelo MySQL 9.0.0, `WolverineFx` 6.39.0 (`WolverineFx.Http`, `WolverineFx.MySql`, `WolverineFx.EntityFrameworkCore`), xUnit.

**Spec:** `docs/superpowers/specs/2026-09-18-cqrs-dispatch-tracking-orders-design.md` → [[2026-09-18-cqrs-dispatch-tracking-orders-design]]

**Milestone map:** [[cqrs-dispatch-all-services-milestone]] holds the workstream sequencing, the cross-workstream dependency graph, and the stop-point reasoning. This note is the **executable task list** for the Tracking and Orders workstreams only; it does not restate that note's content.

---

## Status as of 2026-09-19 — read this before picking up any task

Work is **already in flight** on branch `feature/cqrs-dispatch-all-services`. This plan was written against that reality, not against a clean start. Do not assume an unstarted task list.

| Workstream | State | Evidence |
|---|---|---|
| **Users** | **Done and out of scope** | Superseded by the NestJS migration, already merged into this branch (`92bf49b`, `f24da7b`, `7b6e5e2`). The spec was rescoped to Tracking + Orders. This plan carries **no** Users tasks — see [[2026-09-19-users-nestjs-migration]]. |
| **Phase 1 Tracking** | **In progress, and moving fast** | `internal/bus/` holds `bus.go`, `outcome.go`, `behaviors.go` and their tests; `internal/app/messages.go` defines the six message types; `internal/adapter/http/bus_flows.go` holds a `*Flow()` + `Wrap*()` pair per use case; `handler_reads.go` already invokes `bus.Handler` values and **no longer calls `WorkflowSpan`**. T1–T4 and T6 are substantially done. See the note below on the `Flow`/`Pipeline` shape. |
| **Phase 1 Orders** | **In progress** | Wolverine 6.39.0 added to `Orders.Api.csproj` / `Orders.Infrastructure.csproj` / `Orders.Tests.csproj`; new `src/Orders.Infrastructure/Bus/`, `src/Orders.Application/Messaging/`, `src/Orders.Infrastructure/Orders/Handlers/`, `tests/Orders.Tests/Bus/`; `Program.cs`, `OrderEndpoints.cs`, `InternalEndpoints.cs`, `OrderReadService.cs` and `InvalidateOrderCacheService.cs` modified. Read-only endpoints first, then a write path. `CartWriteService.cs:165` is deliberately **excluded** and carries its own task and its own review step (O6). |
| **Phase 2 Orders spike** | **In progress** | Running in an isolated worktree: does Wolverine's MySQL outbox share EF Core's transaction (rollback AND commit atomicity)? Its verdict **gates** Phase 2 Orders — see [[#Gate G2 — the Wolverine + MySQL outbox spike verdict]]. Both branches are planned below. |
| **Phase 2 (both services)** | **Not started** | Deliberately blocked behind the Phase 1 → Phase 2 review stop point (spec D7) — see [[#GATE G1 — the Phase 1 → Phase 2 review stop point]]. |

Per-task status is marked in each task's heading as `[IN PROGRESS]`, `[DONE — verify only]`, or unmarked (not started). A task marked in progress may already be partly or wholly complete: **read the working tree before writing code**, and treat the task's steps as the acceptance checklist for what is there.

> [!important] Tracking's implementer chose a composite `Pipeline`, not four exported middleware factories
> The tasks below describe the behaviors as four concerns in D4's order, which is what the spec specifies. The implementation expresses them as one `bus.Pipeline[Q,R](h, flow, log)` over a `bus.Flow[Q,R]` descriptor (flow name, attributes, validator, routine-error mapping), with `tracingBehavior`/`appEventBehavior`/`loggingBehavior`/`validationBehavior` **unexported** inside `behaviors.go`, plus `bus.PipelineOrder()` exposing the order for assertion.
> **This satisfies D4 and is not a deviation to correct** — D4 fixes the pipeline's order and semantics, not the number of exported symbols, and one composite entry point makes it impossible for a call site to compose the four in the wrong order. Read `behaviors.go` and `bus_flows.go` before treating any T3–T5 step as unmet: a step asking for "the tracing behavior" is asking for the concern, not for an exported `bus.Tracing`.

## Global Constraints

Every task's requirements implicitly include this section.

- **No dispatched agent runs git writes.** Implementers leave work in the working tree; the main session commits via the A/B/C/D/E confirmation menu. Read-only git (`status`, `diff`, `log`, `show`) is fine. See [[git-workflow]].
- **Run `nvm use` before any Node command** (the E2E suites, the vault validator). The repo pins Node 24.18.0 in `.nvmrc`. **pnpm, never npm/yarn** — see [[package-manager]].
- **This refactor is behavior-preserving.** Existing handler tests must pass **UNCHANGED**. A handler test that has to change to keep passing is a signal the refactor altered externally visible behavior, which is out of scope — stop and report rather than editing the test. See spec Testing.
- **Phase 1 touches no database at all.** No schema changes, no migrations, no new persistence in either service. Every handler keeps writing to the same tables it writes to today; only *how it is invoked* changes. This is what makes a Phase 1 rollback a code-only revert with no data migration to unwind (spec D7). A Phase 1 task that finds itself writing a migration has misread the plan.
- **Pipeline order is fixed and load-bearing:** `tracing -> app_event -> logging -> validation -> handler` (spec D4), identical in both services. Tracing must be outermost so the span exists when later behaviors set attributes; validation must be innermost so it sees the message the handler will.
- **Observability semantics must be reproduced exactly, not approximately** (spec D4, Observability; [[logging-context]]):
  - `app_event: <flow>_started` at pipeline entry, `<flow>_succeeded` / `<flow>_failed` at exit, matching the flow names already in use.
  - `reason` present on `*_failed`, **omitted — never null** otherwise.
  - **No SUCCESS severity.** Success is `INFO` + `app_event=*_succeeded`.
  - **Routine ≠ thrown.** A domain "not found" that a route turns into a 404 produces `*_failed` + `reason` **without** marking the span status ERROR. A behavior that decides from `err != nil` alone collapses the two.
  - **A generic behavior never clobbers a specific `reason`.** Span-attribute writes are last-write-wins per key; the generic fallback defers to a reason the handler already recorded, on both the thrown and the non-throwing routine path.
  - **One failure = one `*_failed` log line.** If the handler already logged its specific line, the generic behavior suppresses its own.
- **No shared bus code across languages.** Rejected explicitly in spec D2. The shared artifact is the documented contract in [[cqrs]].
- **Comments follow [[code-comments]]:** the five tags (`CONTRACT:`, `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`), present tense describing the final state, vault refs as `See [[vault-id]]`, blocks ≤12 lines. `make lint-comments` gates this.
- **Three test layers per changed endpoint** ([[testing]]): unit/integration, internal E2E (direct service URL), gateway E2E with a real Cognito JWT. Plus the category this refactor adds: **bus behaviors get their own unit tests, asserted THROUGH the bus** — see [[#Testing requirements that apply to every task]].

## Testing requirements that apply to every task

Four requirements, each with a task-level consequence. The first three are [[testing]]; the fourth is what this refactor adds.

1. **Three layers per changed endpoint.** Phase 1 changes *how* endpoints are served in both services, so every migrated endpoint needs its internal E2E and gateway E2E re-run (not rewritten — they are framework-agnostic and must pass unmodified). A route that only passes on the service port is not done: a 404 carrying the gateway's own `{"message":"Not Found"}` shape means the request never reached the service.
2. **No gateway/nginx wiring changes are expected.** This refactor adds no new routes, so `infra/modules/api-gateway/main.tf` and `infra/modules/compute/nginx/nginx.conf` should need no edits. If a task finds itself adding a route, it has exceeded the spec's scope — stop and report.
3. **Load tests** (`e2e/load-tests/`, Gatling JS) are run at the Phase 1 close of each service, to confirm the added pipeline layer did not change the shape under sustained traffic. They deliberately send neither `x-e2e-source` nor `x-test-mode`. Note [[e2e-variance-exceeds-effect]]'s caution: one before/after run proves nothing — compare drain rate over 2–3× the export cycle.
4. **Bus-behavior unit tests, asserted through the bus** (spec Testing). A test that calls a handler directly proves nothing about pipeline behavior. This is not a stylistic preference: **709 tests stayed green** in this refactor's reverted Node predecessor while the production path emitted the wrong `reason`, because every test called the handler directly.

### Mutation testing is a required step, not background colour

The spec records three test-validity traps, **every one of which was caught by mutation testing and none by a green suite**:

1. A test-local OTel tracer provider was a silent no-op — the global OTel API accepts only the **first** registration per process, so the spans asserted on were never exported.
2. A db stub returning `null` unconditionally forced 6 of 18 tests down a "not found" branch where they asserted nothing, while all 18 stayed green.
3. A generic pipeline catch stamped `reason: "unhandled_error"` over a handler's specific reason, destroying it — and 709 tests stayed green.

These are framework-independent — they are properties of "a generic pipeline stage wraps a handler", so they recur in Go and .NET exactly as they did in Node. Tasks T3, T4, T7, O3, O4 and O5 therefore each carry an explicit **mutation step** on their span/log assertions. The shape of every one of those steps is the same:

- [ ] **Mutation step shape (referenced by task):** for each critical assertion, make the **single** change below in the production code, run **only** that test, confirm it goes **RED**, then revert the mutation and confirm GREEN again. Record the result in the handoff. An assertion whose test stays green under its mutation is vacuous and must be rewritten before the task is done.
  - Span-status assertion → invert the routine/thrown branch so a routine failure marks the span ERROR.
  - `reason`-deferral assertion → make the generic fallback overwrite the specific reason unconditionally.
  - `app_event` assertion → change the suffix (`_succeeded` ↔ `_failed`).
  - Pipeline-order assertion → reverse the composition order.
  - Exporter/provider plumbing → remove the span emission entirely; if the test still passes, the provider was a no-op (trap 1).

---

## Phase 1 — In-memory dispatch, no database (Tasks T1–T7, O1–O6)

Phase 1 delivers the bus, the behaviors, and the registration in both services. **It touches no database.** The two services are independent — different languages, no shared code — so T\* and O\* can proceed in parallel by different agents.

### Tracking (Go) — Tasks T1–T7

Service root: `services/tracking-go/`. Conventions: `services/tracking-go/CLAUDE.md`, [[tracking-service-design]], [[ADR-0021-tracking-go-gin-sqlc-stack]].

#### Task T1: The generic bus primitives — `Handler`, `Middleware`, `Wrap` `[DONE — verify only]`

The bus is ~60 LOC of composition with no runtime registry and no reflection (spec D1, D5/Go).

**Files:**
- Create: `services/tracking-go/internal/bus/bus.go`
- Test: `services/tracking-go/internal/bus/bus_test.go`

**Interfaces:**
- Consumes: nothing but `context`.
- Produces: `bus.Handler[Q,R]`, `bus.Middleware[Q,R]`, `bus.Wrap` — every later Tracking task depends on these three.

- [ ] **Step 1: Read what is already in the working tree.** `internal/bus/bus.go` and `bus_test.go` exist untracked. Verify rather than rewrite.
- [ ] **Step 2: Confirm the three declarations are present** — `Handler[Q any, R any] func(ctx, Q) (R, error)`, `Middleware[Q any, R any] func(Handler[Q,R]) Handler[Q,R]`, and `Wrap[Q,R](h, mws...) Handler[Q,R]`.
- [ ] **Step 3: Confirm the composition order is pinned by a test.** `Wrap(h, a, b, c)` must make `a` the **outermost** — it enters first and exits last — which means the building loop runs backwards. The order is D4 and it is load-bearing; a test asserting the enter/exit trace is the only thing that catches an inversion, because both orders "work".
- [ ] **Step 4: Confirm the no-middleware case is covered** — `Wrap(h)` returns a handler that behaves as `h`.
- [ ] **Step 5: Run the package tests**

```bash
cd services/tracking-go && go test ./internal/bus/
```

Expected: green.

- [ ] **Step 6: Leave the work in the working tree.** Do not commit.

#### Task T2: The outcome classifier — routine vs thrown, and the reason fallback `[DONE — verify only]`

This is the type that keeps the behaviors from collapsing a 404 into a span ERROR, and the fallback reason from clobbering a specific one. It exists **separately from the behaviors** so the classification decision is testable without an OTel provider.

**Files:**
- Create: `services/tracking-go/internal/bus/outcome.go`
- Test: `services/tracking-go/internal/bus/outcome_test.go`

**Interfaces:**
- Consumes: `errors`.
- Produces: `bus.RoutineFailure`, `bus.Routine(err, reason)`, `bus.Outcome{Failed, Thrown, Reason}`, `bus.Classify(err)`, `bus.ReasonUnhandledError`. Tasks T3–T5 read `Outcome`; T6 wraps sentinels with `Routine`.

- [ ] **Step 1: Read what is in the working tree.** `internal/bus/outcome.go` and its test exist untracked.
- [ ] **Step 2: Confirm `Outcome` keeps `Failed` and `Thrown` as SEPARATE fields.** They are two dimensions: `Failed` selects the `app_event` suffix, `Thrown` decides the span status. One boolean cannot express "log a failure, leave the span OK", which is exactly the routine-404 case.
- [ ] **Step 3: Confirm `Classify` recognises a routine failure through a WRAP** — `errors.As`, not a type assertion. A use case adding context with `%w` would otherwise turn its own 404 into a span-ERROR fault, and the response would still be a 404, so nothing visible to a caller reveals it.
- [ ] **Step 4: Confirm the empty-reason substitution.** A routine failure carrying `""` must reach the log as `unhandled_error`, because an empty value is dropped by the omitted-never-null rule and the line would carry no reason at all.
- [ ] **Step 5: Confirm `Routine` is documented as wrapping at the seam that KNOWS the outcome is routine** — the use case or the wiring that maps its sentinel, never inside a behavior. A behavior deciding for itself has to keep a sentinel list, and a sentinel missing from that list is silently promoted to a span ERROR.
- [ ] **Step 6: Run the package tests**

```bash
cd services/tracking-go && go test ./internal/bus/
```

- [ ] **Step 7: Leave the work in the working tree.**

#### Task T3: The tracing behavior — moving `WorkflowSpan` out of the HTTP handler `[SUBSTANTIALLY DONE — verify]`

This is the task that corrects the layer mismatch the spec's Context/Problem section documents: `tracing.WorkflowSpan(...)` currently lives in the **transport adapter** (`internal/adapter/http/handler_reads.go:112` and `:190`), not in the use case.

**Files (as built):**
- `services/tracking-go/internal/bus/behaviors.go` — `tracingBehavior`, composed by `Pipeline`
- `services/tracking-go/internal/bus/behaviors_test.go`
- `services/tracking-go/internal/adapter/http/handler_reads.go` — the `WorkflowSpan` call and its `defer end(flowErr)` are already gone

**Interfaces:**
- Consumes: `bus.Handler`, `bus.Classify`, `internal/adapter/otel`'s `WorkflowSpan`/`EndFunc`.
- Produces: `bus.Tracing[Q,R](flow string, attrs ...) Middleware[Q,R]` — the outermost behavior in every wrapped handler.

- [ ] **Step 1: The move has already happened — verify it against the original, don't redo it.** `handler_reads.go` no longer calls `WorkflowSpan`; the flow name and attributes now live in `bus_flows.go`'s `GetMyTrackingFlow()` / `ListMyTrackingsFlow()`. Confirm against git that nothing was lost in the move:

```bash
cd services/tracking-go && git diff internal/adapter/http/handler_reads.go | grep -n "WorkflowSpan\|attribute\."
```

The two flows were `get_tracking` (with an `order_id` attribute) and `list_trackings`. Both names and that attribute must appear in the corresponding `Flow` descriptors — a renamed flow silently breaks every dashboard and saved query built on `app_event`.

- [ ] **Step 2: Read `internal/adapter/otel/workflow.go`** and confirm the exact `WorkflowSpan(ctx, name, attrs...) (context.Context, EndFunc)` signature and what `EndFunc(err)` does with a non-nil error. The behavior must not double-record an error the helper already records.
- [ ] **Step 3: Write the failing tests.** Through the bus, never by calling a handler directly. Cover, at minimum:
  - a success emits one INTERNAL span named after the flow, status unset/OK;
  - a **routine** failure (`bus.Routine(domain.ErrTrackingNotFound, "tracking_not_found")`) emits a span with status **NOT** ERROR;
  - a **thrown** failure emits a span with status ERROR and the error recorded **exactly once**;
  - the flow-specific attributes reach the span;
  - the handler receives the span-carrying `ctx`, not the caller's original — otherwise child spans detach.
- [ ] **Step 4: Verify the test's OTel provider is not a silent no-op.** This is trap 1 and it makes every span assertion vacuous. Assert the exporter received **at least one** span in a test you know emits one, before asserting anything about its contents.
- [ ] **Step 5: Run the tests to confirm they fail**

```bash
cd services/tracking-go && go test ./internal/bus/ -run Tracing -v
```

- [ ] **Step 6: Write the behavior.** Open the span, call `next`, `Classify` the error, set the status from `Outcome.Thrown` (not from `err != nil`), end the span exactly once.
- [ ] **Step 7: Run the tests to confirm they pass.**
- [ ] **Step 8: Remove the `WorkflowSpan` call from `handler_reads.go`.** Both sites. The HTTP handler keeps its `errors.Is` status-code mapping — that is transport concern and stays — but no longer opens a span. Leave the 404-not-403 comment intact; it documents a security decision unrelated to this refactor.
- [ ] **Step 9: Check `internal/adapter/http/tracing_middleware_test.go` and `wire_tracer_test.go`.** Both assert on workflow spans emitted through the production router, including `TestServerSpanIsTheWorkflowSpansParent` (the span **relationship**, not merely presence) and `TestEveryWorkflowSpanIsEmittedThroughTheProductionRouter`. These are the tests that catch a span detached from its HTTP parent by the move. If either fails, the wiring is wrong — **do not weaken the assertion**.
- [ ] **Step 10: MUTATION STEP.** Apply the span-status mutation and the exporter mutation from [[#Mutation testing is a required step, not background colour]]. Both must turn a test RED. Record the results.
- [ ] **Step 11: Run the whole service suite** to prove nothing else depended on the handler-level span.

```bash
cd services/tracking-go && go test ./...
```

- [ ] **Step 12: Leave the work in the working tree.**

#### Task T4: The `app_event` and logging behaviors `[SUBSTANTIALLY DONE — verify]`

Two behaviors, one task: they are the pair that must not double-log, and testing that property requires both.

**Files (as built):**
- `services/tracking-go/internal/bus/behaviors.go` — `appEventBehavior`, `loggingBehavior`, `eventSuffix`, `severityOf`, `logFields`
- `services/tracking-go/internal/bus/behaviors_test.go`, `lines_test.go`

**Interfaces:**
- Consumes: `bus.Handler`, `bus.Outcome`, `internal/platform/logging`'s context fields.
- Produces: `bus.AppEvent[Q,R](flow string) Middleware[Q,R]`, `bus.Logging[Q,R](log *slog.Logger) Middleware[Q,R]`.

- [ ] **Step 1: Read `internal/platform/logging`** and an existing flow-log call site, and record the **exact** field names and the flow-name spelling in use today. The behaviors reproduce what exists; they do not redesign it. See [[logging-context]]. Note the shape already built: `Flow` separates `Fields` (log) from `Attributes` (span) deliberately — a span carries what a log line must not, and the log context's allow-list has no span equivalent — and `ResultFields`/`ResultAttributes` run only on success, because the zero result is meaningless on a failure. `Flow.Lines{Started, Succeeded}` is where per-flow line suppression lives: the two reads set both to `false` because the HTTP middleware's `request completed` line already carries route, status and `duration_ms`, and they are the most frequent authenticated calls this service serves. **Verify that suppression is per-flow and deliberate, not a blanket default** — a flow silently emitting nothing is indistinguishable from a broken behavior.
- [ ] **Step 2: Write the failing tests.** Through the bus. Cover:
  - `<flow>_started` at entry, exactly once;
  - `<flow>_succeeded` on success at `INFO`, with **no** `reason` key present at all (not `reason: null`, not `reason: ""`);
  - `<flow>_failed` on a routine failure, carrying the handler's specific `reason`;
  - `<flow>_failed` on a thrown failure, carrying `unhandled_error` **only when no specific reason exists**;
  - **the clobber guard**: a handler that already recorded a specific reason keeps it on the thrown path too;
  - **one failure, one line**: a handler that logged its own specific `*_failed` line does not get a second one from the behavior;
  - `duration_ms` present, and the shared context fields (`trace_id`, `order_id`, `tracking_id`) attached per [[logging-context]].
- [ ] **Step 3: Run the tests to confirm they fail.**
- [ ] **Step 4: Write the two behaviors.** Reading `Outcome` for the suffix and the reason; **never** re-deriving either from `err`.
- [ ] **Step 5: Run the tests to confirm they pass.**
- [ ] **Step 6: MUTATION STEP.** Apply the `reason`-deferral mutation and the `app_event`-suffix mutation. Both must turn a test RED. The reason-deferral mutation is the one that reproduces the exact bug 709 green tests missed — if its test stays green, the assertion is vacuous.
- [ ] **Step 7: Leave the work in the working tree.**

#### Task T5: The validation behavior, and the pipeline-order test that pins D4 `[PARTLY DONE — verify]`

**Files (as built):**
- `services/tracking-go/internal/bus/behaviors.go` — `Validator[Q]` and `validationBehavior`, plus `PipelineOrder()`
- `services/tracking-go/internal/bus/behaviors_test.go`

**Interfaces:**
- Consumes: `bus.Handler`; `bus.Validator[Q] func(q Q) error`, supplied per flow via `Flow.Validate`.
- Produces: the validation stage inside `Pipeline`, and a test asserting the full D4 order.

- [ ] **Step 1: The validation shape is already chosen — verify it rather than re-deciding.** `bus.Validator[Q] func(q Q) error` is a per-flow function on the `Flow` descriptor, not a `Validate()` method on each message. **The open question this task originally carried is answered by that choice**: validation is opt-in per flow, so a flow whose input is already validated by Gin binding supplies no validator and the stage is a pass-through. Confirm each `*Flow()` in `bus_flows.go` either supplies a validator or is deliberately without one, and that **no** flow gained validation that changes an externally visible error body — that would be out of scope (Global Constraints).
- [ ] **Step 2: Write the failing tests** for whichever shape Step 1 selected, including that a validation failure is **routine** (`*_failed` + reason, span not ERROR) and not a thrown fault.
- [ ] **Step 3: Run them red, write the behavior, run them green.**
- [ ] **Step 4: Write the full-pipeline order test.** Wrap a probe handler in all four real behaviors and assert the observed order is `tracing -> app_event -> logging -> validation -> handler`, entering outermost-first and exiting in reverse. This is the test that catches a future reordering; D4's order is load-bearing (see T1 Step 3).
- [ ] **Step 5: MUTATION STEP.** Reverse the composition order and confirm the pipeline-order test goes RED.
- [ ] **Step 6: Leave the work in the working tree.**

#### Task T6: Migrate the read path behind the bus `[SUBSTANTIALLY DONE — verify]`

The first real use cases through the pipeline. Reads first, deliberately: no writes, no transactions, no publishing.

**Files (as built):**
- `services/tracking-go/internal/adapter/http/handler_reads.go` — the two handlers now hold `bus.Handler[...]` fields (`:57`, `:58`) and invoke them (`:135`, `:200`) instead of calling `h.get.Execute`
- `services/tracking-go/internal/adapter/http/bus_flows.go` — `GetMyTrackingFlow()` / `ListMyTrackingsFlow()` + `WrapGetMyTracking` / `WrapListMyTrackings`, and `routineReads` mapping `domain.ErrTrackingNotFound` to `bus.Routine`
- `services/tracking-go/internal/app/messages.go` — `GetMyTrackingQuery`, `ListMyTrackingsQuery`
- Test: `internal/adapter/http/handler_reads_test.go` and `internal/app/*_test.go` must pass UNCHANGED

**Interfaces:**
- Consumes: `bus.Pipeline` and the `Flow` descriptors (T3–T5); the existing `app.NewGetMyTracking` / `app.NewListMyTrackings` constructors.
- Produces: two wrapped `bus.Handler` values, consumed by `NewReadsHandler`.

- [ ] **Step 1: Read `wire_reads.go` in full.** It already builds the two use cases over one adapter, each holding its own one-method port — and its comment says why (neither use case can reach the other's method). The bus wrapping goes **here**, in the wiring, preserving that narrowness. Note that the handler's constructor stays exported so tests bypass `WireReads`; the wrapped handlers must be passed in the same way, or every handler test breaks.
- [ ] **Step 2: Verify the routine sentinel mapping.** `routineReads` in `bus_flows.go` already maps `domain.ErrTrackingNotFound` to `bus.Routine(err, reasonTrackingNotFound)` — in the **wiring**, which is a seam T2 Step 5 permits. Confirm `reasonTrackingNotFound`'s value is the reason string **already** in this flow's logs and not a newly invented token: a renamed reason is invisible in code review and breaks every query built on it.
- [ ] **Step 3: Change the two HTTP handlers to invoke the wrapped handler.** The `errors.Is(err, domain.ErrTrackingNotFound)` status mapping stays — `routineFailure.Unwrap()` exposes the cause, so `errors.Is` against the domain sentinel still decides the status code. Verify this rather than assuming it.
- [ ] **Step 4: Run the existing handler and use-case tests, UNMODIFIED.**

```bash
cd services/tracking-go && go test ./internal/adapter/http/ ./internal/app/
```

Expected: green with **no test edits**. If a test must change, stop and report — that is the signal the refactor altered externally visible behavior (Global Constraints).

- [ ] **Step 5: Confirm the response cache still short-circuits before the bus.** `handler_reads.go` serves a cached body and returns *before* the flow span opens today. Decide and document whether a cache HIT still bypasses the pipeline (no `app_event`, no span) or now goes through it — **either is defensible, but it is an observable change** if it moves, and [[testing]]'s cache E2E asserts on `X-Cache`. Record the decision.
- [ ] **Step 6: Run the service suite, then the internal and gateway E2E suites** for the two read endpoints.
- [ ] **Step 7: Leave the work in the working tree.**

#### Task T7: Migrate the write path behind the bus, and wire the composition root

**Files:**
- Modify: `services/tracking-go/internal/adapter/http/wire_app.go`, and the remaining `handler_*.go` files that invoke a use case
- Modify: `services/tracking-go/cmd/server/main.go` (manual wiring per D5/Go)
- Modify: `services/tracking-go/internal/app/*.go` — sentinel marking only
- Test: every existing `internal/app/*_test.go` and `internal/adapter/http/*_test.go` must pass UNCHANGED

**Interfaces:**
- Consumes: `bus.Wrap` + the four behaviors; every existing use-case constructor in `internal/app/`.
- Produces: one wrapped handler per use case, built once in the composition root and handed to the HTTP layer as a compiler-checked value. There is no registry and no lookup — `bus.Send` in the spec's D3 means invoking one of these pre-wrapped functions.

- [ ] **Step 1: Enumerate the use cases to migrate.** `internal/app/` holds `create_tracking`, `delete_by_user`, `e2e_cleanup`, `get_my_tracking` (T6), `list_my_trackings` (T6), `progression`, `update_status`. Record each one's flow name from its existing log/span call, and its sentinels.
- [ ] **Step 2: Read `internal/app/create_tracking.go`'s CONTRACT comment about narrow per-use-case ports.** A central bus applies widening pressure one layer up; the hand-rolled design is deliberately narrow for the same reason (spec Research findings). Do not introduce a shared "all handlers" interface to make the wiring shorter.
- [ ] **Step 3: Migrate one use case at a time**, running its existing tests unmodified after each. Do not batch them — a single test that must change is the signal worth catching, and batching hides which change caused it.
- [ ] **Step 4: Mark every routine sentinel.** The state machine refusing a transition is routine, not a fault, exactly like a missing tracking. A sentinel left unmarked is silently promoted to a span ERROR (T2 Step 5).
- [ ] **Step 5: Wire the composition root.** `cmd/server/main.go` is ~500 lines and already wires every dependency explicitly. Add the wrapped handlers there, per D5/Go — manual wiring is the accepted cost of full type safety, and the spec's research (point 7) establishes that even a library with a global registry would not save a single line here.
- [ ] **Step 6: Leave `update_status.go`'s publish path alone.** It is the one Tracking handler that publishes, and it is **Phase 2** work (T8). In Phase 1 it changes only in how it is invoked. Its `publish` is best-effort and swallows everything including panics — do not "fix" that here.
- [ ] **Step 7: Run the whole suite plus both E2E layers.**

```bash
cd services/tracking-go && go test ./... && go vet ./...
```

- [ ] **Step 8: MUTATION STEP.** Re-run the span-status and `reason`-deferral mutations now that real handlers are behind the pipeline, not probes. A mutation that was caught by a probe test but not by any real-handler test means the real handlers are not asserted through the bus.
- [ ] **Step 9: Run the load tests** for the tracking read/write flows, comparing drain rate over 2–3× the export cycle, not a single before/after run ([[e2e-variance-exceeds-effect]]).
- [ ] **Step 10: Run `make lint-comments`** and leave the work in the working tree.

### Orders (.NET / Wolverine) — Tasks O1–O6

Service root: `services/orders/`. Conventions: `services/orders/CLAUDE.md`, [[orders-service-design]]. Migration is **endpoint by endpoint**: `WolverineFx.Http` is opt-in per endpoint and coexists with the existing `MapGet`/`MapPost` delegates, so the app runs in a mixed state for the duration — that is expected, not a regression (spec Per-service migration plan).

#### Task O1: Install Wolverine and boot it beside the existing endpoints `[IN PROGRESS]`

**Files:**
- Modify: `services/orders/src/Orders.Api/Orders.Api.csproj`, `src/Orders.Infrastructure/Orders.Infrastructure.csproj`
- Modify: `services/orders/src/Orders.Api/Program.cs`
- Test: `services/orders/tests/Orders.Tests/Api/` — a boot test

**Interfaces:**
- Consumes: the existing `Program.cs` host builder and DI registrations.
- Produces: a configured `IHost` with Wolverine active and `IMessageBus` resolvable. Every later Orders task depends on this.

- [ ] **Step 1: Add the packages at 6.39.0** — `WolverineFx.Http` for Phase 1. `WolverineFx.MySql` and `WolverineFx.EntityFrameworkCore` are **Phase 2** (O7) and are not needed here; adding them early pulls in durability configuration Phase 1 must not have (Global Constraints: Phase 1 touches no database).
- [ ] **Step 2: Write a boot test first.** Wolverine fails at **startup**, not silently at runtime, when a handler chain is misconfigured (spec Risks) — so a test that merely boots the host is a real gate. Assert the host starts and `IMessageBus` resolves.
- [ ] **Step 3: Configure Wolverine in `Program.cs`** with handler discovery scoped to the assembly that holds the handlers, and **no** durability/persistence configured.
- [ ] **Step 4: Confirm the existing endpoints still serve unchanged.** The whole point of the opt-in-per-endpoint property is that nothing breaks before an endpoint is migrated. Run the existing API tests.
- [ ] **Step 5: Run the full test suite**

```bash
cd services/orders && dotnet test
```

- [ ] **Step 6: Leave the work in the working tree.**

#### Task O2: Map `IWorkflowTracer` onto Wolverine middleware `[IN PROGRESS]`

The behavior pipeline for Orders. `WorkflowTracer`/`IWorkflowTracer` exist and 7 service classes call `TraceWorkflowAsync(...)` by hand; this task builds the middleware that absorbs those calls, in D4's order.

**Files:**
- Create: `services/orders/src/Orders.Infrastructure/Observability/` — the Wolverine middleware types (tracing, `app_event`, logging, validation)
- Test: `services/orders/tests/Orders.Tests/Observability/` — behavior tests **through the bus**

**Interfaces:**
- Consumes: `IWorkflowTracer` (kept — it is the span mechanism, and this task changes *where* it is called, not what it does), the existing logging context.
- Produces: the four middleware types, registered once in the pipeline configuration, **not** per handler.

- [ ] **Step 1: Read `IWorkflowTracer` and `WorkflowTracer` in full**, plus two call sites (`OrderReadService.GetMyOrdersAsync` at `:47` is a read; `CreateOrderService` is a write). Note the interface's own CONTRACT: the span carries the **same** attributes as the flow's log line, so trace and logs tell one story. The middleware must preserve that, including `SetAttribute`/`SetReason` being callable from inside the action.
- [ ] **Step 2: Decide how a handler reaches `SetReason` from inside the middleware-owned span.** Existing handlers call `_tracer.SetReason(...)` on failure branches. Those calls must keep working, because they are the specific reasons the generic fallback must not clobber. **Do not remove them.**
- [ ] **Step 3: Write the failing behavior tests, asserted through the bus** — `IMessageBus.InvokeAsync`, never a direct handler call. Cover the same seven properties as Tracking's T3/T4: span per flow, routine-vs-thrown span status, `app_event` suffixes, `reason` present on failure and **absent** on success, the clobber guard, one-failure-one-line, and D4's order.
- [ ] **Step 4: Verify the test's OTel provider is not a no-op** (trap 1) before trusting any span assertion.
- [ ] **Step 5: Run them red, write the middleware, run them green.**
- [ ] **Step 6: Express the routine-vs-thrown distinction explicitly.** .NET's idiom is exceptions, which makes this trap easier to fall into than in Go: `UnknownUserException`, `UnknownProductException`, `InsufficientStockException` exist in `Orders.Application/Abstractions/`. Decide per exception whether it is routine (a 404/400 a route renders) or a genuine fault, and make the middleware read that classification rather than `catch (Exception)`. A blanket catch marks every 404 as a span ERROR.
- [ ] **Step 7: MUTATION STEP.** Span-status, `reason`-deferral, `app_event`-suffix, and pipeline-order mutations. All four must turn a test RED.
- [ ] **Step 8: Leave the work in the working tree.**

#### Task O3: Migrate the first read-only endpoint — the pipeline proof `[IN PROGRESS]`

Reads first, deliberately and for a stated reason: it proves handler discovery, middleware wiring, and the `IWorkflowTracer` → tracing-behavior mapping with **zero transactional risk** — `[NonTransactional]`, no `BeginTransactionAsync` involved (spec Per-service migration plan, step 1).

**Files:**
- Create: the query object + handler for the chosen `OrderReadService` read
- Modify: `services/orders/src/Orders.Api/Endpoints/OrderEndpoints.cs` — opt this one endpoint into `WolverineFx.Http`
- Modify: `services/orders/src/Orders.Infrastructure/Orders/OrderReadService.cs` — remove the hand-rolled `TraceWorkflowAsync` wrapper from the migrated read
- Test: the existing `Orders.Tests` read tests must pass UNCHANGED

**Interfaces:**
- Consumes: O1's host, O2's middleware, the existing `OrderReadService` dependencies.
- Produces: one migrated endpoint and the proven pattern every later endpoint follows.

- [ ] **Step 1: Confirm which read was migrated and read it end to end.** `OrderReadService` is already modified in the working tree. Its two candidates are `GetByIdAsync` (`:35`) and `GetMyOrdersAsync` (flow `list_my_orders`, around `:66` — the file is being edited, so locate it by name, not by line). Note `GetMyOrdersAsync`'s CONTRACT comment: no `http.method`/route tags (the AspNetCore and EF Core spans carry those) and no caller identity (PII-adjacent, already on every log line). The middleware must not start adding either.
- [ ] **Step 2: Mark the handler `[NonTransactional]`.** A read handler must not take Wolverine's transactional middleware. Related and lower-severity but worth doing now: Orders has **separate read/write DbContexts**, and a handler chain may have only one transactional `DbContext` — a handler exposing two `DbContext`-shaped dependencies makes Wolverine fail at **startup**, not silently. Disambiguate with `[Storage(typeof(...))]` where needed (spec Risks).
- [ ] **Step 3: Write the handler** as a plain class with constructor injection and a `Handle` method — convention-discovered, no attribute needed for discovery.
- [ ] **Step 4: Opt the endpoint into Wolverine** and leave every other endpoint on its existing `MapGet`/`MapPost` delegate.
- [ ] **Step 5: Remove the now-duplicated `TraceWorkflowAsync` wrapper** from the migrated read. If it stays, the flow gets **two** spans and two `app_event` pairs — a silent double-emission no status code reveals.
- [ ] **Step 6: Run the existing tests UNMODIFIED**, then the internal E2E and the **gateway E2E with a real Cognito JWT** for this endpoint. A 404 carrying the gateway's own `{"message":"Not Found"}` shape means the request never reached the service.
- [ ] **Step 7: MUTATION STEP** on this endpoint's span/log assertions, now going through a real handler rather than a probe.
- [ ] **Step 8: Leave the work in the working tree.**

#### Task O4: Migrate the remaining read endpoints `[IN PROGRESS]`

**Files:**
- Modify: `src/Orders.Api/Endpoints/OrderEndpoints.cs`, `ProductEndpoints.cs`, `CartEndpoints.cs` (read routes only), `InternalEndpoints.cs` (reads only)
- Modify: `src/Orders.Infrastructure/Orders/OrderReadService.cs`, `ProductReadService.cs`, `src/Orders.Infrastructure/Carts/CartReadService.cs`
- Test: the existing read tests must pass UNCHANGED

- [ ] **Step 1: Enumerate the read endpoints and their flows**, recording each one's flow name and its `SetReason` tokens, from the source. Every `reason` string that appears there must appear in the migrated path and be asserted.
- [ ] **Step 2: Migrate one endpoint per step**, following O3's shape exactly: query object, `[NonTransactional]` handler, endpoint opt-in, remove the duplicated tracer wrapper, run the existing tests unmodified.
- [ ] **Step 3: Check `InvalidateOrderCacheService` — already modified in the working tree.** The spec counts it among the 7 classes repeating `TraceWorkflowAsync`. Read what was done and record the reasoning: it is invalidation, not a request-scoped read or write, so "handler behind the bus" is not automatically right for it. If it became a bus handler, confirm its flow still emits the same `app_event` it did before.
- [ ] **Step 4: After the last read, run the full suite plus both E2E layers, and the load tests** for the read flows.
- [ ] **Step 5: Leave the work in the working tree.**

#### Task O5: Migrate the write path — EXCLUDING `CartWriteService.cs:165` `[IN PROGRESS]`

The write path is where Wolverine's transactional middleware meets Orders' explicit transaction management. This is the milestone's **headline risk** (spec Risks): Wolverine's middleware in default **Eager** mode opens its own transaction and calls `SaveChangesAsync()` for the handler, while Orders has three explicit `BeginTransactionAsync` call sites — `CreateOrderService.cs:128`, `CartWriteService.cs:113`, and `CartWriteService.cs:165`. There is also a `ForUpdateInterceptor` rewriting SQL to append `FOR UPDATE` on tagged queries, which must keep working inside whichever transaction owns the connection.

**`CartWriteService.cs:165` — the concurrent-PUT retry — is deliberately excluded from this task** and is O6. Do not fold it in.

**Files:**
- Create: command objects + handlers for `CreateOrderCommand`, `UpdateCartCommand` (the `:113` path only), the delete/internal writes
- Modify: `src/Orders.Api/Endpoints/CreateOrderEndpoint.cs`, `CartEndpoints.cs` (write routes), `E2eEndpoints.cs`, `InternalEndpoints.cs` (writes)
- Modify: `src/Orders.Infrastructure/Orders/CreateOrderService.cs`, `DeleteOrdersByUserService.cs`, `src/Orders.Infrastructure/Carts/CartWriteService.cs` (**`:113` only**)
- Test: existing write tests must pass UNCHANGED

**Interfaces:**
- Consumes: O2's middleware; the existing services' constructor dependencies, unchanged.
- Produces: migrated write handlers, each carrying an explicit, recorded per-handler transaction decision.

- [ ] **Step 1: Note how little the call shape has to change.** `CreateOrderEndpoint` already calls `service.CreateAsync(new CreateOrderCommand(...))` — a Wolverine handler with a different method name. The migration is largely renaming `CreateAsync` → `Handle` and keeping the constructor dependencies as they are, **not** restructuring the call shape (spec Per-service migration plan).
- [ ] **Step 2: Decide the transaction ownership PER HANDLER, and record the decision and its reason in the handoff.** Two mitigations, both legitimate (spec Risks):
  - **(a)** mark the handler `[NonTransactional]` and keep its explicit `BeginTransactionAsync`, flushing the outbox manually in Phase 2; or
  - **(b)** restructure so Wolverine owns the transaction, and verify the `FOR UPDATE` queries run **inside** it.
  This is a **decision point, not a default**. Wolverine's open issue #1735 covers exactly this friction. A handler migrated without a recorded decision is not done.
- [ ] **Step 3: Read `CreateOrderService.cs:128` in context** before touching it. `BeginTransactionAsync` sits inside `AmbientActor.RunAsync(AuditActor.CreateOrder, ...)`, so the audit interceptor stamps `CreatedBy`/`UpdatedBy` from the ambient actor. If Wolverine takes over the transaction, verify the ambient actor is still set when the interceptor runs — a lost actor writes wrong audit fields and **no test asserts on it today** (see [[testing]] and the audit-field convention).
- [ ] **Step 4: Verify the `ForUpdateInterceptor` still appends `FOR UPDATE`** under whichever transaction owns the connection. A row lock silently not taken is a concurrency bug with no symptom under sequential tests.
- [ ] **Step 5: Leave `CreateOrderService`'s SNS publish behind `IEventPublisher`.** Do **not** adopt Wolverine's SNS transport — publish-only in this repo's usage (no listening, no request/reply), so it would be a second migration bundled into this one (spec Per-service migration plan, step 4). Phase 2 has the outbox call it through that same interface.
- [ ] **Step 6: Migrate one write handler per step**, running the existing tests unmodified after each.
- [ ] **Step 7: Run the full suite, both E2E layers, and the load tests** for the write flows.
- [ ] **Step 8: MUTATION STEP** on the write path's span/log assertions.
- [ ] **Step 9: Leave the work in the working tree, and state in the handoff that `CartWriteService.cs:165` is untouched.**

#### Task O6: `CartWriteService.cs:165` — the concurrent-PUT retry, its own task and its own review step

> [!danger] This task has its own review step and must not be folded into O5
> This is the same class of concurrency requirement CLAUDE.md flags as the **highest-risk case for review**, and it is structurally not exercised by ordinary tests. In this repo, the cart's concurrent-PUT retry was specified in the design spec from its first commit, **shipped as an unhandled 500**, passed its per-task review, and was caught only by chance in a later whole-branch pass. See [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]].
> Reviewing this task means **enumerating the requirement and ticking it off against the diff** — not asking whether the code is internally consistent. It will be; that is the failure mode.

**Files:**
- Modify: `services/orders/src/Orders.Infrastructure/Carts/CartWriteService.cs` (the `:165` retry path)
- Modify: `src/Orders.Api/Endpoints/CartEndpoints.cs` (the PUT route)
- Test: `services/orders/tests/Orders.Tests/Infrastructure/` — a test that actually exercises concurrent writes

**Interfaces:**
- Consumes: O2's middleware, O5's recorded transaction decisions.
- Produces: the migrated retry path with its retry semantics **provably** intact.

- [ ] **Step 1: Read `CartWriteService.cs` around `:165` in full, and write down the retry's specification before changing anything** — what it retries on, how many times, what it does when retries are exhausted, and what the caller sees. That written statement is the checklist the review ticks against.
- [ ] **Step 2: Confirm the existing test coverage of the retry, honestly.** If no test exercises two concurrent writers, say so in the handoff. Ordinary tests structurally do not exercise concurrency, so "the tests pass" is not evidence here.
- [ ] **Step 3: Write a test that exercises the concurrent path** — two writers racing the same cart, asserting the retry's specified outcome and not merely the absence of an exception. If a genuine concurrent test is not achievable in this suite, say **why**, explicitly, in the handoff; do not substitute a sequential test and call the requirement covered.
- [ ] **Step 4: Decide the transaction ownership for THIS handler specifically.** The `ForUpdateInterceptor` and an explicit `BeginTransactionAsync` interact here in a way they do not on the `:113` path. `[NonTransactional]` plus the existing explicit transaction is the conservative choice; if Wolverine takes ownership, the row lock and the retry must both be **demonstrated** still to work, not assumed.
- [ ] **Step 5: Migrate the handler.**
- [ ] **Step 6: Run the existing cart tests UNMODIFIED, the cart internal E2E, and the cart gateway E2E.**
- [ ] **Step 7: MUTATION STEP, specific to the retry.** Disable the retry (make it attempt once) and confirm the concurrency test goes RED. A retry test that passes with the retry removed is testing nothing — and that is precisely how this requirement was lost the first time.
- [ ] **Step 8: STOP. Report to the parent for this task's own review step**, with: the written specification from Step 1, the diff, the concurrency test, and the mutation result. Do not continue to another task before that review.
- [ ] **Step 9: Leave the work in the working tree.**

---

## GATE G1 — the Phase 1 → Phase 2 review stop point

> [!warning] This is a hard stop, not a checkpoint to note in passing
> Spec D7 places a review stop point between Phase 1 and Phase 2, and calls it **load-bearing, not optional**. Phase 1 touches no database; Phase 2 is the only phase that does. A Phase 1 rollback is a code-only revert — that property exists **only** if Phase 2 has not started. Per [[phase-c-review-flow]], the user merges every PR; one approval authorizes only that batch.

**Nothing in Phase 2 starts until all of the following are true.** Do not begin T8 or O7 to "save time while waiting" — starting Phase 2 is what forfeits the code-only rollback.

- [ ] Tracking Phase 1 complete: T1–T7 done, `go test ./...` green, existing handler tests **unmodified**.
- [ ] Orders Phase 1 complete: O1–O6 done, `dotnet test` green, existing tests **unmodified**.
- [ ] O6 has passed **its own** review step (O6 Step 8), separately from the rest of the write path.
- [ ] Both services' internal E2E and **gateway E2E with a real Cognito JWT** green.
- [ ] Load tests run for both services' changed flows, compared over 2–3× the export cycle.
- [ ] Every mutation step recorded, with the mutated assertion named and the RED confirmed.
- [ ] Every per-handler transaction decision from O5 Step 2 and O6 Step 4 recorded in writing.
- [ ] The open questions resolved in T5 Step 1, T6 Step 5 and O4 Step 3 recorded with their evidence.
- [ ] The main session has presented the batch of open PRs to the user **as one list** and the user has reviewed/merged it.

## Phase 2 — The transactional outbox (Tasks T8–T9, O7–O8)

Phase 2 is the **only** phase that touches a database: one new table per service, in that service's own database, created through that service's existing migration mechanism, plus a poller component per service (spec D6). Database-per-service is preserved — a single shared outbox store was **considered and rejected**, because it would put the business write and the outbox write in two different transactions against two different databases, reintroducing the exact loss window the outbox exists to close.

**Blast radius: 2 handlers total** (spec D6). Every query handler and every non-publishing command is untouched by Phase 2 — they only ever see the Phase 1 bus change.

- **Orders (1)** — `src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- **Tracking (1)** — `internal/app/update_status.go`, publishing via `internal/adapter/notify/status_changed.go`

### The shape change, in both services

Today each handler does two independent operations — write to its database, then publish to SNS — with a failure window between them where an event is lost if the process dies after the write and before the publish. Under the outbox the handler writes the business row **and** the outbox row in one transaction, and a separate poller publishes afterward by reading the outbox table.

### Tracking (Go) — Tasks T8–T9

#### Task T8: The outbox table and the transactional write

**Files:**
- Create: `services/tracking-go/migrations/00000N_add_outbox.up.sql` / `.down.sql`
- Modify: `services/tracking-go/internal/app/update_status.go`
- Modify/Create: `services/tracking-go/internal/adapter/notify/` — the outbox-writing publisher
- Test: `services/tracking-go/internal/app/update_status_test.go` (extend, do not weaken), plus an integration test against a real MySQL

**Interfaces:**
- Consumes: `oagudo/outbox` v1.0.1 in **unmanaged** mode — it accepts a transaction the caller already owns, which fits sqlc's `database/sql` usage (spec D6).
- Produces: an outbox row written inside `update_status`'s existing transaction; the poller (T9) consumes it.

- [ ] **Step 1: Add the migration through golang-migrate**, matching the schema `oagudo/outbox` documents. Both `.up.sql` and `.down.sql` — a Phase 2 rollback needs the down.
- [ ] **Step 2: Read `update_status.go` in full first.** Note two things the plan must not break: steps 1 and 2 are deliberately separate so a rejection is never published, and `publish` is **best-effort, swallowing everything including panics**, with the publisher owning its own failure logging and machine-readable reason. Under the outbox the publish moves out of the request path entirely — decide and record what happens to that swallow-everything guarantee.
- [ ] **Step 3: Write the failing test.** Prove **atomicity in both directions**, which is the only property that matters: a committed business write leaves exactly one outbox row, and a **rolled-back** business write leaves **none**. A test asserting only the commit path cannot distinguish a shared transaction from two separate ones.
- [ ] **Step 4: Run it red, write the outbox write into the existing transaction, run it green.**
- [ ] **Step 5: Verify against a real MySQL, not a mock.** [[testing]] and this repo's own record are clear that mocked persistence tests pass while the real schema or driver rejects. Note that Tracking's pytest-era suite shared the local DB — confirm the current Go integration tests' database handling before assuming isolation.
- [ ] **Step 6: Confirm the existing `update_status` tests pass UNCHANGED** except for genuinely new outbox assertions added alongside them.
- [ ] **Step 7: Leave the work in the working tree.**

#### Task T9: The Tracking poller process — real work, not a side effect of a table

> [!important] The poller is a distinct component, written and operated
> Spec D6 says so explicitly: Orders gets Wolverine's built-in durability agent for free, **Tracking does not**. Tracking needs a poller **process**, using `SELECT ... FOR UPDATE SKIP LOCKED` so that running multiple instances of the service does not double-publish the same outbox row. Treat this as separately-planned work with its own tests and its own operational story.

**Files:**
- Create: the poller (its own package under `internal/`), and its start/stop wiring in `cmd/server/main.go`
- Create: the poller's tests, including a **concurrent** one
- Modify: `services/tracking-go/CLAUDE.md` — the operational note, if the service's conventions file is where run-time components are documented

**Interfaces:**
- Consumes: T8's outbox table; the existing `EventPublisher` (SNS) — broker-agnostic is why `oagudo/outbox` was chosen (spec D6).
- Produces: a running poller that publishes and marks rows, exactly once per row across instances.

- [ ] **Step 1: Write the concurrency test FIRST.** Two pollers against the same table must not publish the same row twice. `FOR UPDATE SKIP LOCKED` is the mechanism, and a test with one poller cannot tell a correct implementation from a broken one — this is the same structural blindness as O6's retry.
- [ ] **Step 2: Write the poller.** Claim with `SELECT ... FOR UPDATE SKIP LOCKED`, publish, mark, commit.
- [ ] **Step 3: Decide and record the failure semantics** — retry policy, backoff, what happens to a row that fails repeatedly, and whether a poison row blocks the queue. An unbounded retry on a permanently-failing row is a silent stall.
- [ ] **Step 4: Decide and record where the poller runs** — in-process with the service (simplest; means every instance polls, which is why SKIP LOCKED is required) or as a separate process. Record the choice and its operational consequence.
- [ ] **Step 5: Instrument it** per [[logging-context]] and [[ADR-0019-distributed-tracing-opentelemetry]]. A trace that stops at the outbox write and resumes with no link to the publish is a broken waterfall: the publish happens in a different process context, so the traceparent has to travel **through the outbox row**. Decide how, and test it.
- [ ] **Step 6: MUTATION STEP.** Remove `SKIP LOCKED` and confirm the concurrency test goes RED. If it stays green, the test is not actually concurrent.
- [ ] **Step 7: Run the tracking E2E suites** — the status-change flow's notification must still arrive, now via the poller rather than an inline publish. This is the end-to-end proof the outbox did not break the chain (tracking event → SNS → notification row → WebSocket).
- [ ] **Step 8: Leave the work in the working tree.**

### Orders (.NET) — Tasks O7–O8, gated by G2

## Gate G2 — the Wolverine + MySQL outbox spike verdict

> [!warning] Phase 2 Orders does not start until this spike has a verdict
> The spike is **in progress right now** in an isolated worktree (see [[#Status as of 2026-09-19 — read this before picking up any task]]). Spec D6 requires Phase 2 Orders to *begin* with it: MySQL is a lightly-travelled path for Wolverine (~27k downloads vs. 4.2M for Postgres), so this repo could be an early reporter on an edge case. The spike de-risks that exposure; it is not chasing an uncertified integration.

**What the spike must answer, precisely:** does Wolverine's MySQL outbox write share EF Core's transaction — **both** directions? A committed business write must leave exactly one outbox row, and a **rolled-back** business write must leave **none**. Commit-only evidence cannot distinguish a shared transaction from two separate ones that both happened to succeed.

**The theory says yes, by construction:** `Wolverine.MySql` depends on MySqlConnector 2.4.0 and `Pomelo.EntityFrameworkCore.MySql 9.0.0` also depends on MySqlConnector 2.4.0, so the `DbConnection`/`DbTransaction` instances are the same concrete types and Wolverine's EF Core bridge enlists with no adapter layer. The spike exists because "sound by construction" and "verified on this stack" are different claims.

- [ ] **Gate step: record the spike's verdict here before starting O7**, with the rollback-path evidence, not just the commit path.

**Branch A — the spike PASSES → Task O7 (Wolverine's durable outbox).**
**Branch B — the spike FAILS → Task O7-alt (hand-rolled outbox, the same design Tracking uses).** The fallback is named in the spec and is not a re-design: it is Tracking's shape (own table via EF Core migrations, own poller with `SELECT ... FOR UPDATE SKIP LOCKED`) expressed in .NET. **Branch B therefore also inherits T9's poller work**, which Branch A gets for free from Wolverine's durability agent — that is the real cost difference between the branches, and it must be stated to the user when the verdict is reported, not discovered later.

#### Task O7: Orders' durable outbox — Branch A (spike passed)

**Files:**
- Modify: `src/Orders.Api/Orders.Api.csproj` / `Orders.Infrastructure.csproj` — add `WolverineFx.MySql`, `WolverineFx.EntityFrameworkCore` at 6.39.0
- Modify: `src/Orders.Api/Program.cs` — `opts.PersistMessagesWithMySql(connectionString)`
- Modify: `src/Orders.Infrastructure/Orders/CreateOrderService.cs`
- Create/Modify: `src/Orders.Infrastructure/Migrations/` — the outbox schema
- Test: `tests/Orders.Tests/` — atomicity in both directions, against a real MySQL

**Interfaces:**
- Consumes: G2's verdict; O5's recorded transaction decision for `CreateOrderService`.
- Produces: `CreateOrderService`'s SNS publish moved behind the outbox, still through `IEventPublisher`.

- [ ] **Step 1: Confirm G2 recorded a PASS with rollback-path evidence.** If not, this task does not start — O7-alt does.
- [ ] **Step 2: Decide who creates the outbox schema.** Wolverine can auto-create it; Orders' existing mechanism is EF Core migrations (spec D6 table). An auto-created table that no migration records is invisible to anyone reading the migration history — record the choice either way.
- [ ] **Step 3: Reconcile with O5's transaction decision for `CreateOrderService`.** If the handler is `[NonTransactional]` with its own explicit transaction, the outbox must be flushed manually; if Wolverine owns the transaction, verify the `AmbientActor` audit stamping from O5 Step 3 still works. These are not independent choices.
- [ ] **Step 4: Write the failing atomicity test — both directions**, as in G2 and T8 Step 3.
- [ ] **Step 5: Run it red, wire the outbox, run it green, against a real MySQL.**
- [ ] **Step 6: Keep `SnsEventPublisher` behind `IEventPublisher`** and let the outbox call it through that interface. Do **not** adopt Wolverine's SNS transport (spec Per-service migration plan, step 4).
- [ ] **Step 7: Note Wolverine's issue #1735** — messages occasionally stuck in the outbox via a `RaiseSideEffects` double-flush, affecting all providers, not MySQL specifically. Decide whether to assert anything about it, and record the decision. Being aware of a known upstream issue is worth more than a test that cannot reach it.
- [ ] **Step 8: Run the order-creation E2E suites** — the `ORDER_CREATED` chain must still fire end to end.
- [ ] **Step 9: Leave the work in the working tree.**

#### Task O7-alt: Orders' hand-rolled outbox — Branch B (spike failed)

Only if G2 recorded a FAIL. Same design as Tracking's T8+T9, in .NET.

- [ ] **Step 1: Record the spike's failure mode** in the handoff, and surface it to the user with its cost: Branch B inherits the poller work Branch A got free. A third-party integration that does not hold up is a **decision for the user**, not something to grind hypotheses against — bring it to them after the spike's verdict, not after several attempted fixes.
- [ ] **Step 2: Add the outbox table via EF Core migrations** in `src/Orders.Infrastructure/Migrations/`.
- [ ] **Step 3: Write the outbox row inside `CreateOrderService`'s existing explicit transaction** (`:128`), and test atomicity in both directions against a real MySQL.
- [ ] **Step 4: Write the .NET poller**, with `SELECT ... FOR UPDATE SKIP LOCKED` and a concurrency test, following T9's steps 1–6 including the trace-continuity decision in T9 Step 5 and the SKIP LOCKED mutation in T9 Step 6.
- [ ] **Step 5: Consider removing `WolverineFx.MySql` / `WolverineFx.EntityFrameworkCore`** if Branch B means Wolverine is no longer the durability mechanism. Leaving an unused durability package configured is a configuration hazard. Record the decision.
- [ ] **Step 6: Run the order-creation E2E suites and leave the work in the working tree.**

#### Task O8: Phase 2 close — both services verified together

- [ ] **Step 1: Run both services' full unit/integration suites.**
- [ ] **Step 2: Run the internal E2E and gateway E2E suites** for every flow either outbox touches.
- [ ] **Step 3: Verify the full event chains end to end** — order creation (`ORDER_CREATED`) and tracking status change (tracking event → SNS → notification row → WebSocket toast). The outbox moved the publish out of the request path in both; the chain arriving is the only proof it still works.
- [ ] **Step 4: Run the load tests** for both services and compare drain rate over 2–3× the export cycle. The outbox adds a write per publishing request and a polling process — a throughput change here is expected; an unbounded outbox backlog is not.
- [ ] **Step 5: Verify the traces.** A trace that stops at the outbox write and never links to the publish is a regression [[ADR-0019-distributed-tracing-opentelemetry]] cares about. If OpenObserve's trace waterfall returns HTTP 400 (`code 20004`, `gen_ai_operation_name`), run `make observability-traces-schema` — that is a known stream-schema gap, not a tracing bug.
- [ ] **Step 6: Run `make lint-comments`** in both services.
- [ ] **Step 7: Leave the work in the working tree** and hand the batch to the main session.

## Task T10 / O9: Documentation propagation — the milestone is not done without it

Per [[doc-propagation]], a spec/plan is not done when written; it is done when its decisions have landed in the category folders they belong to. This is the last task, before the feature → `main` PR is **proposed** (never merged) at milestone close.

- [ ] **Step 1: Route every vault write through the `obsidian-vault` agent** — it is the sole writer of `docs/`. Do not edit `docs/` from an implementer agent or the main session.
- [ ] **Step 2: Propagate to the targets this plan declares** in `propagates-to:`, updating each and bumping its `updated:`:
  - [[tracking-service-design]] — the bus as Tracking's dispatch layer, and that `WorkflowSpan` now lives in the tracing behavior, not the HTTP handler.
  - [[orders-service-design]] — Wolverine as Orders' dispatch layer, the per-handler transaction decisions, and the outbox.
  - [[cqrs]] — the shared contract: the four concepts (message/handler/behavior/bus) and D4's fixed pipeline order, defined **once** here and linked from both service specs, never duplicated into them.
  - [[dependency-injection]] — manual wiring in Tracking's composition root as the documented rule (D5/Go), and convention-based discovery in Orders (D5/.NET).
  - [[logging-context]] — the routine-vs-thrown distinction and the reason-deferral rule, if they are not already stated there in a form a new pipeline author would find.
  - [[testing]] — the bus-behavior test category (assert **through** the bus) and mutation testing as a required step for pipeline assertions.
- [ ] **Step 3: Link bidirectionally.** Each target's `## Related` links back to [[2026-09-18-cqrs-dispatch-tracking-orders-design]] and to this plan; a one-way link is how specs end up referenced from one index and nowhere else.
- [ ] **Step 4: Write the lessons.** Any debugging loop that cost real time — the transactional-middleware conflict, the spike's verdict if it failed, a trap a mutation step caught — is a `docs/lessons/YYYY-MM-DD-<title>.md` candidate, not a source comment. Surface them in the handoff so the parent routes them.
- [ ] **Step 5: Update each service's `CLAUDE.md`** with the rules a future agent needs before touching a handler: that dispatch goes through the bus, that D4's order is fixed, and that Tracking's wiring is manual by decision. [[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]] is this repo's own record of a rule that lived only in the vault and was therefore not read.
- [ ] **Step 6: Run the validator**

```bash
nvm use && node scripts/validate-vault.mjs
```

A pre-existing "Propagation debt" count for notes older than 2026-07-28 is the gate working, not failing.

- [ ] **Step 7: Leave the work in the working tree.** The main session proposes the feature → `main` PR and stops; the user merges after review.

## Self-Review

Run against the spec after the plan is written.

**Spec coverage:**

| Spec section | Where it lands |
|---|---|
| D1 — contract not library; Wolverine + hand-rolled Go bus | T1–T2, O1; Global Constraints |
| D2 — bus per service, only the contract shared | Global Constraints; T10/O9 Step 2 ([[cqrs]]) |
| D3 — uniform call shape | T7 Step 5 (pre-wrapped values, no lookup); O3 Step 3 |
| D4 — fixed pipeline order, exact semantics | Global Constraints; T3, T4, T5 Step 4, O2 |
| D5 — auto-registration per stack | T7 Step 5 (manual, Go); O1 Step 3, O3 Step 3 (convention, .NET) |
| D6 — outbox both services, own table, own DB | T8, T9, O7/O7-alt; Phase 2 preamble |
| D6 — blast radius is 2 handlers | Phase 2 preamble |
| D6 — Tracking needs a poller PROCESS | T9, and its inheritance by O7-alt |
| D6 — shared outbox DB rejected | Phase 2 preamble |
| D7 — two phases, review stop point between | Phase 1 / GATE G1 / Phase 2 structure |
| D7 — Phase 1 touches no database | Global Constraints; O1 Step 1 |
| Migration plan — Orders reads before writes | O3, O4 before O5 |
| Migration plan — `CartWriteService.cs:165` separate | O6, with its own review step and its own callout |
| Migration plan — keep `SnsEventPublisher` behind `IEventPublisher` | O5 Step 5, O7 Step 6 |
| Migration plan — Tracking's `WorkflowSpan` moves layer | T3 Steps 8–9 |
| Testing — three layers | Testing requirements §1; every task's E2E step |
| Testing — bus behaviors get their own tests, through the bus | Testing requirements §4; T3–T5, O2 |
| Testing — behavior-preserving, tests pass unchanged | Global Constraints; T6 Step 4, O3 Step 6, O5 Step 6 |
| Testing — three test-validity traps, mutation testing | Testing requirements; mutation steps in T3, T4, T5, T7, O2, O3, O5, O6, T9 |
| Observability — exact `app_event`/`reason`/severity semantics | Global Constraints; T4, O2 |
| Observability — routine vs thrown | T2, T3, T4, O2 Step 6 |
| Risk — transactional middleware vs explicit transactions | O5 Step 2 (per-handler decision), O6 Step 4, O7 Step 3 |
| Risk — separate read/write DbContexts, startup failure | O3 Step 2 |
| Risk — MySQL durability lightly travelled | Gate G2, both branches |
| Risk — scope/size | Phase 1/Phase 2 split, GATE G1 |
| Open question — Orders endpoint order | O3 Step 1 records the choice; O4 Step 1 enumerates |
| Open question — Tracking manual wiring grows linearly | T7 Step 5; flagged, not solved (out of scope) |

**Three places this plan goes beyond the spec, deliberately:**

1. **T5 Step 1 treats Tracking's validation mechanism as an open question.** The spec names `validation` as a pipeline stage but never specifies what Tracking validates or where. Inventing a mechanism could change externally visible error bodies, which the spec puts out of scope — so the task resolves it from the code and permits a documented pass-through.
2. **T6 Step 5 raises the response cache.** `handler_reads.go` serves a cached body and returns before the flow span opens. The spec does not mention this, and whether a cache HIT now goes through the pipeline is an observable change either way.
3. **O5 Step 3 raises the `AmbientActor` audit stamping.** `CreateOrderService`'s `BeginTransactionAsync` sits inside `AmbientActor.RunAsync`, so if Wolverine takes the transaction the audit interceptor's actor may be lost — and no current test asserts on it. The spec's transactional-middleware risk covers the transaction; it does not mention the audit coupling.

**Type consistency:** `bus.Outcome` (T2) is produced by `Classify` and read by the tracing (T3), `app_event` and logging (T4) behaviors. `bus.Routine` (T2) is applied at the sentinel seams in T6 Step 2 and T7 Step 4 and recognised through `errors.As` by `Classify`. `bus.Handler[Q,R]` (T1) is the value `Wrap` returns, built in `WireReads`/`wire_app.go`/`main.go` (T6, T7) and invoked by the Gin handlers. In Orders, `IWorkflowTracer` (O2) is kept as the span mechanism and its `SetReason` calls stay in the handlers (O2 Step 2) so the generic fallback has a specific reason to defer to.

## Out of scope

- **Users (Node/NestJS)** — superseded entirely by [[2026-09-19-users-nestjs-migration]] and already merged into this branch. No Users tasks here.
- **events-pipeline** — not part of this refactor; it runs a per-record dispatch model not addressed by the spec.
- **Extracting shared bus code across languages** — rejected explicitly (spec D2).
- **Changing any handler's externally visible behavior.** A handler test that must change to keep passing is a signal of an unintended change, not a licence to edit the test.
- **Adopting Wolverine's SNS transport** — publish-only in this repo's usage; it would be a second migration bundled into this one (spec Per-service migration plan, step 4).
- **`go:generate` codegen for Tracking's `Wrap(...)` wiring** — recorded in the spec as a future option that *composes with* the hand-rolled bus. Not this plan's work.
- **Adopting `go-mink`** for Tracking — evaluated and rejected (Postgres-only, no typed query bus, near-zero adoption); a candidate for a future new service wanting event sourcing on Postgres.
- **Any broker or topology change** for Tracking's SNS publisher beyond what `oagudo/outbox`'s unmanaged mode requires to accept an existing transaction.
- **New routes, and therefore any gateway/nginx wiring change.** See Testing requirements §2.

## Related

- [[2026-09-18-cqrs-dispatch-tracking-orders-design]] — the design spec this plan executes.
- [[cqrs-dispatch-all-services-milestone]] — the milestone-level map: workstream sequencing, dependency graph, stop-point reasoning.
- [[2026-09-19-users-nestjs-migration]] — the Users workstream's plan; the structural precedent for this note and the reason Users is out of scope here.
- [[cqrs]] — the shared contract, defined once and linked from both service specs.
- [[dependency-injection]] — manual wiring (Tracking) vs convention-based discovery (Orders).
- [[screaming-architecture]] — the layering the bus must not flatten.
- [[tracking-service-design]] — propagation target for Tracking's dispatch layer.
- [[orders-service-design]] — propagation target for Orders' dispatch layer and outbox.
- [[logging-context]] — the `app_event`/`reason`/severity semantics the behaviors reproduce exactly.
- [[testing]] — the three test layers, plus the bus-behavior category this refactor adds.
- [[ADR-0002-cqrs]] — the CQRS decision this refactor operationalizes.
- [[ADR-0019-distributed-tracing-opentelemetry]] — the tracing backend and span conventions.
- [[ADR-0021-tracking-go-gin-sqlc-stack]] — Tracking's stack, which the hand-rolled bus fits.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — why O6 has its own review step.
- [[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]] — why T10/O9 Step 5 updates each service's `CLAUDE.md`.
- [[code-comments]] — the five tags and the present-tense rule.
- [[git-workflow]] — the A/B/C/D/E confirmation menu; no dispatched agent runs git writes.
- [[phase-c-review-flow]] — batch review and dependency gates, which GATE G1 and G2 implement.
- [[doc-propagation]] — the routing table T10/O9 follows.
