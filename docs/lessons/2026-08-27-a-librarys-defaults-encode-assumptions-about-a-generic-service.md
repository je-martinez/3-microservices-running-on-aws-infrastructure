---
title: "A library's instrumentation defaults encode assumptions about a generic service — verify them against what YOUR service actually carries"
type: lesson
area: shared
status: active
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/lesson
  - area/shared
  - area/tracking
  - status/active
  - severity/medium
related:
  - "[[ADR-0019-distributed-tracing-opentelemetry]]"
  - "[[logging-context]]"
  - "[[tracking-service-design]]"
---

# A library's instrumentation defaults encode assumptions about a generic service — verify them against what YOUR service actually carries

## Finding

`otelsql` (the OpenTelemetry `database/sql` driver wrapper used by `services/tracking-go`)
ships two defaults that are individually reasonable for a generic service and individually
wrong for this one. Both were found the same way: not by reading the library's docs and
guessing, but by observing what a real instrumented call actually emitted.

**Instance 1 — `db.query.text` records the literal SQL by default.** An instrumented `UPDATE`
was observed emitting `db.query.text = "UPDATE trackings SET
shipping_address='221B Baker Street' ..."` with no options set. Tracking's write statements
carry `shipping_address`, and a span attribute fans out to the collector and to OpenObserve
exactly like a log line does — so this is a PII leak, not noise. Fixed with
`SpanOptions{DisableQuery: true}`.

**Instance 2 — `driver.ErrSkip` is recorded as an ERROR by default, on both spans and
metrics.** `driver.ErrSkip` is a `database/sql` sentinel meaning "this optional fast path is
not implemented, use the generic one" — internal control flow, not a failure. It is not rare
here: `go-sql-driver/mysql` returns it from `connection.go:439` and `:498` for **every**
parameterized statement while `InterpolateParams` is off, which is the default. So before the
fix, essentially every query this service made carried a false exception on its span, and the
error status rendered successful spans as failed. `otelsql` also stamps `error.type` on the
`db.client.operation.duration` **metric** for the same non-event, independently of the span
setting — so **both** `SpanOptions.DisableErrSkip` and `WithDisableSkipErrMeasurement(true)`
had to be set together. Suppressing only the span half would leave a dashboard and a trace
disagreeing about the same non-event. Fixed in commit `81c8ffe`.

## The transferable lesson

**A library's instrumentation defaults are tuned for a generic service, not yours.** Whoever
wrote `otelsql` chose reasonable-sounding defaults — record the query text, treat every
non-nil driver error as an error — that are individually defensible in isolation and wrong for
a service whose queries carry PII, or whose driver returns a specific sentinel on its ordinary
path. **Verify a library's observability defaults against what your service actually emits
and actually carries**, rather than assuming a widely-used library's defaults are safe because
they are the default. Two hostile defaults from the *same* library, found in the *same*
service, is the signal that this is a pattern to check for deliberately — not a coincidence to
patch and move past.

The check that finds these is the same both times: **instrument a real call and read what it
actually produced**, not what the option name implies it should produce. Reading the source
(`otelsql`'s `recordSpanError`) after the fact confirms the mechanism, but the finding itself
came from the waterfall, not from the docs.

## The diagnostic worth preserving

While writing the regression test for Instance 2, a fake driver whose `Prepare` call failed
produced `error.type = *errors.errorString` on the span — the **exact string** the user
originally reported from the waterfall. That was the fake failing in the prepare-then-exec
fallback path, not a reproduction of the product bug. **After this fix, a stray
`*errors.errorString` (or any non-`ErrSkip` type) on a database span is no longer `ErrSkip` and
DOES deserve investigation** — the suppression is scoped to the one sentinel, not to "errors on
database spans" in general. Confusing the two in either direction — treating a genuine error as
the known-safe sentinel, or treating the sentinel as a genuine error — is exactly the failure
mode Instance 2 exists to prevent.

## How to apply

- Before adopting any OTel instrumentation library (`otelsql`, `otelgin`, `otelgrpc`,
  auto-instrumentation packages), instrument one real call in a local environment and read the
  actual span/metric attributes it produced — do not assume the defaults are safe because the
  library is widely used.
- Cross-reference what the library records against what **your** service's queries/handlers
  actually carry: PII columns (`shipping_address` here), sentinels your driver returns on its
  ordinary path (`driver.ErrSkip` here), or anything else domain-specific the library's authors
  could not have anticipated.
- When a library exposes the same hostile default through more than one surface (span
  attribute AND metric, here), fix both together and in the same change — one fixed and one
  left stale is worse than neither, because it produces two views of the same data that
  disagree.
- Keep the diagnostic that told the two failure modes apart (the fake-driver `Prepare` failure
  vs. the real `ErrSkip`) next to the fix — it is what lets the next person distinguish "this is
  the known-safe non-event" from "this is new and real" without re-deriving it from scratch.

## Related

- [[ADR-0019-distributed-tracing-opentelemetry]] — the OpenTelemetry/OpenObserve backend
  decision this instrumentation feeds; both instances live in `services/tracking-go`'s otelsql
  wiring documented there.
- [[logging-context]] — the PII rules (never log `shipping_address`, never a plaintext email)
  that Instance 1 is a span-shaped instance of; also documents the sibling rule that OTel
  configuration belongs in environment variables, not code — a related but distinct hazard
  (mis-configuration vs. a library default) from the same instrumentation surface.
- [[tracking-service-design]] — the service spec whose Observability section documents the Go
  otelsql wiring these two instances concern.
