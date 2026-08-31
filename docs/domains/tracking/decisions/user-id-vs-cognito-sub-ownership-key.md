---
title: Tracking scopes reads by cognito_sub, not user_id — the two identities are not interchangeable
type: adr
area: tracking
status: accepted
id: tracking-user-id-vs-cognito-sub
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-31
updated: 2026-08-27
tags: [type/adr, area/tracking, status/accepted, issue/JE-90, issue/JE-91]
related:
  - "[[tracking-service-design]]"
  - "[[orders-service-design]]"
  - "[[authenticated-identity-resolution]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
---

# Tracking scopes reads by cognito_sub, not user_id — the two identities are not interchangeable

## Context

A `Tracking` row carries two distinct identity columns: `user_id` (the internal `usr_…` id,
resolved by Tracking itself via an outbound gRPC call to Users, see
[[tracking-service-design#gRPC — outbound client to Users]]) and `cognito_sub` (the Cognito
`sub`, arriving on every request already). The two are **not interchangeable**, and using the
wrong one to scope a user-facing read is not a crash — it is a silent, plausible-looking
wrong answer.

The gateway injects the caller's identity as the `x-user-id` header, but that header always
carries the JWT's **`sub`** (`proxy_set_header x-user-id $jwt_sub` in
`infra/modules/compute/nginx/nginx.conf`, see [[nginx-njs-x-user-id-injection]]) — never the
`usr_` id. A read scoped by `user_id` therefore compares a Cognito sub against a `usr_…`
value. It never matches — not even for the row's rightful owner — and the handler answers
`404 Not Found` to every caller, including the one who just created the tracking. The
response looks like an ordinary "not found," not an error, so nothing about it signals a bug.

This shipped once. **253 tests did not catch it**, because every test that asserted ownership
created and read a tracking using the **same** value for both identities — a property test
that only ever exercises `user_id == user_id` or `sub == sub` cannot fail on a bug that only
manifests when the two diverge, which is the normal case in production (a `usr_…` id is never
equal to a UUID sub). Orders solves the identical shape of problem
(`order`/`order_details` also carry both `user_id` and `cognito_sub`) the same way described
below, and hit the same trap first — see [[authenticated-identity-resolution]] for the
sibling gap on the Users side (header injection missing entirely, a related but distinct
failure mode).

## Decision

- Every **user-scoped** REST read (`GET /v1/trackings/{orderId}`,
  `GET /v1/trackings?order_ids=...`) filters by `order_id` **and** the caller's
  `cognito_sub` — never `user_id` — using the value carried on the gateway-injected
  `x-user-id` header, per [[tracking-service-design#Ownership & scoping]].
- The HTTP accessor that resolves the caller is named `CallerSub` / `RequireCallerSub`
  (`services/tracking-go/internal/adapter/http/auth.go`) — deliberately **not** named anything
  that reads as "the user id," so a handler reaching for identity cannot reach for the wrong
  column by a plausible-sounding name. `UserIDHeader` is the misleading name the header itself
  carries; the doc comment on the accessor says so explicitly.
- `cognito_sub` is optional on the wire and nullable in the schema, so a caller that predates
  the field still creates successfully; an empty string is normalized to `NULL` rather than
  stored as `""`, so an unset value is unreachable by any subsequent read rather than
  mis-attributed to a caller whose sub happens to be empty.
- **Any test asserting ownership must use two different values for the two identities** — a
  single shared value cannot exercise this bug regardless of how many assertions surround it.
  This is now a required shape for ownership tests, not just this one test suite; see
  [[testing]].

## Go-specific reinforcement — scoped and unscoped reads are SEPARATE METHODS

The Go port ([[2026-08-27-tracking-go-migration-design]]) surfaced a second, mechanism-specific
way this exact class of bug can reappear, worth recording here because it is a reinforcement of
this ADR's decision, not a new one:

> **Never one method with an optional identity parameter.** Go's zero value for `string` is
> `""`, **not `nil`**. An unset optional-scope parameter therefore silently means *"scoped to
> the empty string"* rather than *"unscoped"* — and the caller reads nothing, every time, while
> looking correctly implemented. The inverse mistake — accidentally scoping an unscoped call —
> is just as easy to introduce the same way.

A dynamically-typed language can pass `None`/`null` as "no scope" and a statically-typed one
with nullable references can pass `nil`; Go's `string` has no such state to fall back on. The
port's fix was **two separate methods**: `GetByOrderIDScoped(ctx, orderID, cognitoSub)` for the
user-facing reads, and `GetByOrderID(ctx, orderID)` — taking **no identity parameter at all** —
for the carrier webhook and the TestMode progression, both of which are legitimately unscoped.
The mistake then has nowhere to happen: there is no parameter to leave unset, because the
unscoped method does not declare one. `internal/app/progression.go`'s `UnscopedTrackingReader`
port documents this rule at the boundary where it matters most.

## Consequences

- User-scoped reads are correct for the case that matters (a caller reading their own
  tracking) and correctly return `404`, not `403`, for a tracking that exists but belongs to
  someone else — see [[tracking-service-design#Ownership & scoping]] for why `403` would leak
  existence.
- `user_id` remains on both `Tracking` and `Tracking_History` for reporting and cross-service
  joins, but is never a filter predicate on a request path driven by end-user identity. A
  future endpoint that filters by `user_id` on a user-facing read repeats this bug.
- The bug class generalizes beyond Tracking: any table carrying both an internal id and an
  externally-supplied identity token needs the same two-distinct-values discipline in its
  ownership tests. See the companion lesson if one is written for the `contextvars`
  propagation work in the same milestone.

## Related

- [[tracking-service-design]] — the affected endpoints and the full ownership/scoping rule.
- [[orders-service-design]] — Orders carries the same two columns and resolves the identical
  problem the same way.
- [[authenticated-identity-resolution]] — the sibling Users-side gap (missing header
  injection, then a lookup querying only `id`), a related but distinct failure mode on the
  same `sub`-vs-internal-id boundary.
- [[nginx-njs-x-user-id-injection]] — confirms `x-user-id` always carries the JWT `sub`,
  never the `usr_` id, which is the root of why `user_id` cannot be used as the filter.
- [[testing]] — the three-layer convention; the two-distinct-values rule is now part of what
  "endpoint test coverage" means for any ownership-scoped read.
- [[logging-context]] — both `cognito_sub` and `user_id` are shared log-context fields;
  logging the wrong one as if it were the ownership key would carry the same confusion into
  observability.
- [[2026-08-27-tracking-go-migration-design]] — the Go port that surfaced the Go-specific
  reinforcement above: scoped and unscoped reads as separate methods, never one method with an
  optional identity parameter.
