---
title: CQRS
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-09-18
tags: [type/pattern, area/shared, status/active]
related: ["[[dependency-injection]]", "[[screaming-architecture]]", "[[orders-service-design]]", "[[clean-architecture-divergence]]"]
---

# CQRS

## Pattern

Commands (writes) and queries (reads) are separated. Each command type and each event type maps to its own dedicated handler, rather than sharing a monolithic service class.

## The rule this pattern enforces

**A route/controller/endpoint delegate is transport only. It never contains domain
logic, and it never queries a data store directly.** This holds regardless of how small,
internal, or "just a lookup" the endpoint is — internal/service-to-service routes are not
exempt, and a one-line-looking query is not exempt either. There is no size threshold below
which inlining is acceptable, because the failure this rule prevents is not about line count:
it is about domain logic having no single, testable, reusable home once it starts living in
transport code.

**What belongs on each side of the line:**

| Transport (route/controller) | Handler (command/query/event) |
|---|---|
| Binding the request (path/query/body params, headers) | Resolving domain entities and their invariants |
| AuthN/authZ checks (API key, JWT claims, ownership) | Querying or writing the DbContext / repository |
| Calling exactly one handler | Branching on domain state (found/not-found, valid/invalid) |
| Mapping the handler's result to a status code and response DTO | Deciding what a failure means (404 vs 409 vs 400) |
| Structured logging/tracing scaffolding (span start, `_started`/`_succeeded`/`_failed`) around the handler call | The actual work the log line describes |

**Detectable symptom of a violation:** an endpoint delegate that takes a `DbContext`
(or repository/ORM session) as a parameter, or resolves one from a service locator, and
runs a query or an `ExecuteUpdateAsync`/save against it inline. If a transport-layer
signature accepts a `*DbContext`, `*ReadDbContext`, `*WriteDbContext`, `IQueryable<...>`,
or equivalent, that signature is the pattern being broken — even if the query is a single
`Where(...).FirstOrDefaultAsync()` and even if the surrounding branching (not-found →
404) looks trivial enough to inline. That branching *is* the domain decision the handler
exists to own, and "trivial" is exactly the size at which this gets rationalized past
review.

- "Internal" (service-to-service, unauthenticated-by-JWT) and "small" endpoints get the
  same handler split as any public route. An internal audience changes who calls the
  route, not what belongs inside it.
- A handler existing elsewhere in the codebase but not being *called* — the endpoint
  reimplementing the same query inline instead of injecting the handler — is the same
  violation as never having written the handler, and is easy to miss because the diff
  looks self-contained: nothing looks broken from inside the endpoint file alone.
- Copying the shape of a neighbouring route is not a defense. A sibling endpoint with the
  same violation is precedent for the bug, not for the pattern — check the pattern note,
  not the file next to the one you're writing.

## How we apply it

- Services model their write operations as commands and their reads as queries, each routed to a single handler.
- The events pipeline applies the same shape: a `TYPE => TypeHandler` mapping dispatches each event type to its handler.
- Handlers are wired through [[dependency-injection]] and live as first-class use-cases under our [[screaming-architecture]] folder layout. In services with a Clean-Architecture project split (see [[clean-architecture-divergence]]), a "handler" is the dedicated service class in the Infrastructure/use-case layer (e.g. `OrderReadService`, `CreateOrderService`) — the project name differs from the screaming-architecture default, but the endpoint-stays-thin rule is identical.

## Related

- [[dependency-injection]] — how command/query/event handlers get their collaborators wired.
- [[screaming-architecture]] — handlers surface as use-case folders in the structure.
- [[versioning]] — versioned APIs front these handlers.
- [[orders-service-design]] — Orders' internal endpoints as the concrete example this rule was tightened for.
- [[clean-architecture-divergence]] — where "handler" lives when a service uses class-library projects instead of screaming-architecture folders.
- [[2026-09-18-cqrs-rule-lived-only-in-the-vault-not-in-the-file-agents-read-first]] — the propagation failure that let this violation happen despite the rule already existing here.
