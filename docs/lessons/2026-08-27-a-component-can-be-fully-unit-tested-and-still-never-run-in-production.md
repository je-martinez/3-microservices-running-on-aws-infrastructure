---
title: "A component can be fully unit-tested, reviewed, and merged — and never run in production"
type: lesson
area: tracking
status: active
created: 2026-08-27
updated: 2026-08-27
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/critical
  - milestone/tracking-go-migration
related:
  - "[[2026-08-27-tracking-go-migration-design]]"
  - "[[tracking-service-design]]"
  - "[[ADR-0021-tracking-go-gin-sqlc-stack]]"
  - "[[2026-08-27-go-vs-python-performance]]"
  - "[[testing]]"
  - "[[2026-08-26-cache-keys-built-from-a-raw-identity-header]]"
  - "[[ADR-0008-screaming-arch-di]]"
---

# A component can be fully unit-tested, reviewed, and merged — and never run in production

## Finding

The Tracking Go migration ([[2026-08-27-tracking-go-migration-design]]) hit the same defect
shape **five separate times**. In each case a component was written, unit-tested, code-reviewed,
and merged — and never once called from the actually-running process:

1. **Route handlers existed; `main.go` registered none of them.** The handlers had their own
   unit tests exercising them directly and passing. The route table simply never mounted them.
2. **`SetResolvedUserID` existed; nothing called it.** The response cache's key builders decline
   to build a key without a resolved `usr_` id — so the cache was permanently inert, not
   TTL-limited, not degraded: **always** a `MISS`, silently, from the day it shipped.
3. **`NewContextHandler` and `NewTraceHandler` existed and were exercised only by their own
   tests.** In the running process, **0 of 348 log lines** carried a `trace_id` — every log line
   was valid JSON with correct fields, just permanently unjoinable to its trace.
4. **The cache gateway's metrics port was bound to the noop unconditionally.**
   `cache_requests_total` was computed on every request and thrown away, even with
   `METRICS_ENABLED=true`. This one was caught while producing a performance comparison
   (see [[2026-08-27-go-vs-python-performance]]) that briefly read "Go is 400x faster than
   Python" — an artifact of Go doing less work (publishing zero metrics), not doing the same
   work faster. The gap vanished after a rebuild fixed the wiring.
5. **Missing `otelgin`, so the gateway's `traceparent` was discarded.** Every workflow span
   started its own trace instead of continuing the caller's, and the log-line ordering
   middleware bug (below) made this worse: even once `otelgin` was wired, the wrong ordering in
   the middleware chain re-created failure #3 in a new place — see "The middleware order is
   load-bearing" below.

**Every one of the five had a green unit test suite.** This is not incidental — it is the shape
of the bug. A unit test constructs its own subject and calls it directly, so it exercises the
component in complete isolation from the question "is anything in the real process reaching
this?" A component can be perfectly correct and 100% unit-tested while being **structurally
unreachable** from `main()`.

## Why no test caught it, and why the obvious tools don't help

- **An ordinary unit or integration test cannot catch this even in principle.** Its own call
  site satisfies its own assertion — that is what makes it a unit test. There is no version of
  "test the wiring bug" written as a unit test against the component itself, because the
  component itself is not what's broken; the absence of a caller is.
- **Hexagonal architecture makes this worse, not better, for exactly the reason it is otherwise
  valuable.** Ports and adapters buy isolation by making every component independently
  constructible — [[ADR-0021-tracking-go-gin-sqlc-stack]] and the migration's hexagonal choice
  ([[2026-08-27-tracking-go-migration-design]]) chose this for the compiler-enforced domain
  purity it gives. But independently constructible is exactly what lets a component be fully
  exercised by its own tests and reached by nothing in production. The same property that
  prevents infrastructure from leaking into the domain also lets a real wiring gap hide
  perfectly.
- **`golangci-lint`'s `unused` linter is structurally blind to this class of bug, verified —
  not assumed.** An **exported** dead function is not flagged (only unexported ones are), and a
  function referenced only from a `_test.go` file is not flagged either. In a hexagonal design
  every seam crosses a package boundary and is therefore exported by construction — so the one
  static-analysis tool that looks like it should catch "this is never called" cannot see this
  exact shape.
- **Manual constructor injection ([[ADR-0008-screaming-arch-di]]'s deliberate divergence for
  this service) removes a container that might otherwise fail loudly on a missing binding.**
  There is no framework here to complain that a dependency was declared but never wired — wiring
  by hand in `cmd/server/main.go` means an omission compiles cleanly and runs cleanly, silently
  serving a degraded version of the service.

This is a different failure shape from — but related to —
[[2026-08-26-cache-keys-built-from-a-raw-identity-header]], where the code ran but on the wrong
key. Here the code frequently doesn't run at all.

## The guard that closes it, and its honest limit

`cmd/server/wiring_reachability_test.go` walks the **static call graph from `main()`** over the
production package set (`go list -deps ./cmd/server` — exactly the set the binary actually
links), and asserts every seam in a `requiredSeams` table is reachable. Each seam carries a
`reason` string naming what silently breaks in production if it is not wired — because a bare
"X is not reachable" just hands the next person the same rediscovery cost this lesson exists to
avoid.

**The gate's limit was measured by mutation, not reasoned about, and it matters:** the walk asks
"is this symbol **mentioned** anywhere reachable from `main`", not "is its return value actually
installed and functioning." Replacing a real `otelgin.Middleware(...)` call with a no-op closure
that still *mentions* the tracing filter leaves the reachability gate green — while four
behavioural tests in `internal/adapter/http/tracing_middleware_test.go` fail loudly on the exact
same mutation. The two layers divide the work on purpose:

- **The reachability gate catches total absence** — the shape all five historical bugs actually
  took. Cheap, one line per seam, scales to the whole composition root.
- **A behavioural test catches partial or subtly-wrong installation** — expensive to write, so
  reserved for seams where "wired but wrong" is a realistic failure mode (the middleware chain
  above all).

## The middleware order is load-bearing, in both directions

A related trap surfaced while fixing bug #3/#5: `gin.Recovery()` → `otelgin.Middleware` →
`LogContextMiddleware` → the flag middlewares, registered in that order (first registered =
outermost).

- **`otelgin` must sit ABOVE `LogContextMiddleware`.** `otelgin` installs the span on the request
  context only for the duration of its own `c.Next()`, and **restores the pre-span context on the
  way out**. `LogContextMiddleware` writes its `request completed` line after **its own**
  `c.Next()` — which must still be *inside* `otelgin`'s, so the span is present when the line is
  written and `trace_id`/`span_id` get stamped. Get the order backwards and that line is written
  after `otelgin`'s deferred restore has already stripped the span: valid JSON, correct field
  names, `trace_id` and `span_id` silently omitted. That is bug #3 reappearing in a new location,
  produced entirely by ordering rather than absence.
- **`Recovery` must stay outermost.** `LogContextMiddleware` observes a panic, counts it as a 500,
  and re-raises; producing the actual response is still `Recovery`'s job. Get this inverted and
  the re-raise escapes to `net/http` with the connection dropped and no response at all.

## The transferable lesson

**A component that can be constructed and tested in complete isolation can also be wired to
nothing, and no unit test — however thorough — will ever notice, because the test IS the
isolated construction that hides the gap.** Treat "is this reachable from the actual entry
point" as a separate, explicit verification question from "does this component work when
called" — the two are not the same claim and a green suite only ever answers the second one.
When adding a middleware, an exporter, a background loop, or any other install-once component,
add it to an explicit reachability list in the same commit; a pure function whose absence breaks
compilation does not need this (the compiler already guards it) — this is specifically for
things that are *inert unless wired* and *silent* when they aren't.

## How to apply

- Any composition root wiring dependencies by hand (this service's deliberate
  [[ADR-0008-screaming-arch-di]] divergence, or any manually-injected system) needs an explicit
  reachability check — a static call-graph walk from the real entry point over the real
  production package set, not a convention someone has to remember to uphold by eye.
- Do not trust `unused`/dead-code linters to catch a mis-wired **exported** symbol. Verify this
  for your own toolchain rather than assuming — the blind spot is specific to how the linter
  scopes "used."
- When a behavioural test suite is green and a suspicious metric or log field is nonetheless
  absent in the real running process (a `0 of N lines carry trace_id` count; a metric published
  by one arm of a comparison and not the other), suspect wiring before suspecting the metric or
  the comparison itself.
- Pair a reachability gate (cheap, catches total absence) with targeted behavioural tests on the
  seams where "wired but subtly wrong" — not just "wired or not" — is a real risk, such as a
  middleware chain whose order changes correctness.

## Related

- [[2026-08-27-tracking-go-migration-design]] — the migration this pattern was found during;
  §"Observability and event parity" and the closing gate criterion 4 (observability parity) it
  blocked until fixed.
- [[tracking-service-design]] — the service spec this migration's decisions propagate into.
- [[ADR-0021-tracking-go-gin-sqlc-stack]] — the hexagonal-architecture and manual-DI decisions
  that make this failure shape possible in the first place.
- [[2026-08-27-go-vs-python-performance]] — the false "Go is 400x faster" result produced by
  wiring bug #4 (cache metrics bound to noop), and how it was caught.
- [[testing]] — the three-layer testing convention; this bug class is invisible to all three
  layers as ordinarily written, which is why a fourth, structural check (reachability) exists.
- [[2026-08-26-cache-keys-built-from-a-raw-identity-header]] — a related but distinct failure
  shape from the same service family: code that runs, but against the wrong key, rather than
  code that never runs at all.
- [[ADR-0008-screaming-arch-di]] — the repo's default DI-container convention, and this
  service's deliberate, documented divergence from it (manual constructor injection), which is
  the direct cause of there being no framework to complain about an unwired dependency.
