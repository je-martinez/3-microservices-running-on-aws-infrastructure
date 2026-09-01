---
title: Testing
type: convention
area: shared
status: active
created: 2026-07-17
updated: 2026-08-29
tags: [type/convention, area/shared, status/active]
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[ADR-0016-local-apigw-nginx-ecs]]"
  - "[[local-dev]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway-design]]"
  - "[[2026-07-17-testing-layers-and-e2e-gateway]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-29-e2e-email-support-store]]"
  - "[[2026-08-29-the-emulator-was-the-ceiling-not-the-code]]"
  - "[[2026-08-03-events-pipeline-milestone-design]]"
  - "[[2026-08-05-passwordless-otp-auth-design]]"
  - "[[2026-08-05-passwordless-otp-auth]]"
  - "[[passwordless-auth-type]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
  - "[[2026-08-12-custom-business-metrics-cloudwatch-design]]"
---

# Testing

## Rule

Every HTTP endpoint MUST have all three test layers before it is considered done:

1. **Unit / integration** — the endpoint's logic tested in isolation. Orders uses xUnit with
   Testcontainers-MySQL through the in-process `WebApplicationFactory`; Users uses vitest with a
   mocked container; Tracking uses `go test` against a **live** MySQL rather than mocks —
   specifically the **shared local `tracking` database** (Floci grants the `test` user no
   `CREATE DATABASE` privilege, so a throwaway per-run database is not an option), which means
   any fixture touching the schema must restore it exactly as found. `make test` alone silently
   **skips** the database-backed tests and still prints `ok`; `make test-db` (or
   `TRACKING_DATABASE_URL`/`TRACKING_TEST_MYSQL_DSN` set by hand) is what actually runs them. See
   [[tracking/testing/index#Layer 1 — unit / integration]] and
   `services/tracking-go/CLAUDE.md` §6 for the full mechanics.
2. **Internal E2E** — the service's own URL hit directly, bypassing the gateway, with `x-user-id`
   faked. Each service has its own internal Playwright spec running against its own port: orders
   against `http://localhost:3001`, users against `http://localhost:3000`, tracking against
   `http://localhost:3002`. Do not assume users' port applies to every service — each service gets
   its own spec at its own port.
3. **Gateway E2E** — the `API_GATEWAY_URL` the end user actually hits, with a real
   `Authorization: Bearer <Cognito JWT>`. This is the only layer that exercises the full
   user-facing path: JWT authorizer → njs sub-extraction → nginx routing → service.

**File structure — every service needs BOTH Playwright specs.** Layers 2 and 3 are not one spec
each in the abstract — every service MUST have exactly two Playwright spec files, and both must
exist and cover the service's endpoints:

- **Internal spec:** `e2e/tests/<service>.spec.ts` — the `internal` project, hits the service
  directly (orders on `http://localhost:3001`, users on `:3000`) with `x-user-id` faked.
- **Gateway spec:** `e2e/tests/gateway/<service>.spec.ts` — the `gateway` project, hits
  `API_GATEWAY_URL` with a real JWT.

**An endpoint missing either its internal OR its gateway E2E spec is an incomplete change** — the
same imperative as the OpenAPI golden rule applies here. Run all E2E layers with
`pnpm --filter @3mrai/e2e test`, which executes both the `internal` and `gateway` Playwright
projects. This requires the local stack to be up via `make bootstrap` (see [[local-dev]]).

**Commands.** `make test-e2e` (or its shorthand `pnpm e2e`) is exactly that
`pnpm --filter @3mrai/e2e test` run — use whichever is convenient. On-demand commands for the
three layers:

- `make test-all` — all three layers for every service (unit + internal E2E + gateway E2E);
  E2E requires the stack up (`make bootstrap`).
- `make test-unit` — layer 1, now **six suites**: orders (`dotnet test`), users (`vitest`),
  events-pipeline (`vitest`), realtime-events (`vitest`), the Cognito CUSTOM_AUTH
  `otp-challenge-lambda` trigger (`vitest`), and tracking (`pytest`) — plus the e2e `typecheck`
  step. No stack needed.
- `make test-e2e` — layers 2+3 (Playwright internal + gateway); requires the stack up.
- `pnpm --filter @3mrai/e2e typecheck` (or `pnpm run typecheck` from `e2e/`) — static type-check
  of the E2E specs; also runs as part of `make test-unit`.
- Granular package.json scripts: `pnpm orders:test`, `pnpm users:test`, `pnpm e2e:internal`,
  `pnpm e2e:gateway`, `pnpm e2e` (both projects).

> [!warning] Three of those six suites existed and nothing invoked them
> `realtime-events`, `events-pipeline`, and the Cognito `otp-challenge-lambda` trigger's tests
> were never wired into `make test-unit` — 658 tests total that read as coverage in a review and
> could not fail, because nothing ran them. Found only when a logging change to the Cognito
> trigger needed its tests and the only way to run them was borrowing another package's vitest by
> hand. The Cognito trigger additionally had **no `package.json`**, so `pnpm --filter` could not
> even see it; it is a pnpm workspace package now (`infra/modules/cognito/otp-challenge-lambda`)
> for that reason alone. This does not change what ships: Terraform's `archive_file` excludes
> `node_modules`, `package.json`, and the test file from the zip, so the deployed Lambda artifact
> is unchanged — it still ships as a bare `index.mjs` depending on nothing outside `node:crypto`.
> A suite nobody invokes is worse than no suite at all: it cannot fail, so the code it guards
> drifts freely underneath it.

**A fourth Playwright project: `observability`.** `e2e/tests/observability/` asserts that every
field the committed OpenObserve dashboards query still exists in its stream — it generates a real
flow (register → login → products → order → tracking), waits for the logs/metrics to land, and
only then checks field presence (never row counts, since a legitimately empty panel is not a
bug). Unlike `internal` and `gateway`, this project additionally needs `make observability-up` on
top of `make bootstrap` — it skips with a named reason when OpenObserve is unreachable, rather
than failing as a confusing connection error.

**Symmetry check:** when adding a service or endpoint, confirm both `e2e/tests/<svc>.spec.ts` and
`e2e/tests/gateway/<svc>.spec.ts` exist and cover it — an easy asymmetry to miss (this is exactly
what happened with orders: a gateway spec existed with no internal spec until it was caught in
review).

## Rationale

Unit/integration and internal E2E tests both fake the authorizer — they inject `x-user-id`
directly and never touch the gateway. An endpoint can pass every one of those tests and still be
broken for the actual user, because nothing in that path exercises the real Cognito JWT, the
authorizer, or nginx's routing rules (see [[ADR-0010-cognito-auth]], [[ADR-0016-local-apigw-nginx-ecs]]).

This gap is not theoretical: in a single session, three gateway-only bugs shipped past every
existing test. `/v1/products` returned 404 because the gateway route was never added. `GET
/v1/orders/{orderId}` returned 405 because the integration path dropped the id segment. A path
parameter named with an underscore crashed Floci's routing regex with a 500. All three were
invisible to unit, integration, and internal E2E tests, and all three surfaced immediately through
the gateway URL. Gateway E2E closes that gap by testing exactly what the user hits, not a
convenient stand-in for it.

## Per-service guidance

This convention defines the rule; each service documents how it satisfies the three layers and
the checklist for adding a new endpoint:

- [[orders/testing/index|Orders Testing]]
- [[users/testing/index|Users Testing]]
- [[tracking/testing/index|Tracking Testing]]

## Adapting the three layers to a non-HTTP component (events-pipeline)

The three-layer rule above is written for HTTP endpoints — request in, response out, a gateway
to test against. The events-pipeline Lambda has none of that; it is SQS-triggered. Rather than
skip testing rigor because the literal layers don't apply, the events-pipeline milestone adapted
the same **unit → integrated → real production path** progression to its own shape:

1. **Unit, no AWS.** The state machine (`process-record.ts`, all four transitions,
   append-only `status_history`), error classification (`PermanentError` vs `TransientError`,
   including the unclassified-is-transient default), Zod schemas (envelope + per-type payload,
   valid and invalid cases), dispatch (known type → right handler, unknown type → `FAILED`
   "Unknown event type"), and template rendering (every catalog entry renders without throwing,
   snapshotted).
2. **Integration against real DocumentDB and real Mailpit — never mocks.** This is not a
   preference; it reproduces the repo's own lesson experimentally. Removing `unique: true` from
   the `event_id` index left the **unit** suite green at 10/10 (nothing there touches a real
   index) while the **integration** suite, run against a live DocumentDB, failed 3 — the same
   mocks-hide-schema-bugs failure mode already documented for Prisma in this repo, now reproduced
   for MongoDB's own driver. SES delivery is asserted via the Mailpit API, not a mock — recipient,
   subject, and that the body contains the event's data.
3. **End-to-end, the real path.** The analogue of gateway E2E: `POST /v1/users/register` through
   the gateway → Users' real publisher puts the message on SQS → the event source mapping invokes
   the Lambda → the document appears in DocumentDB as `COMPLETED` → the email appears in Mailpit.
   This is the layer that exercises the event source mapping itself, which nothing below it does,
   and it is what was actually run to verify the milestone: a real `POST /v1/users/register`
   produced a document walking `STARTED → IN_PROGRESS → COMPLETED` and a "Welcome to 3MRAI" email
   in Mailpit.

See [[events-pipeline-design]] and [[2026-08-03-events-pipeline-milestone-design]] for the full
detail, including the dedicated `batchItemFailures` test (inject one good message and one that
triggers a transient failure; assert the good one is consumed exactly once and only the bad one
retries).

### The E2E email-support store is a diagnostic channel, never an assertion channel

Shipped 2026-08-29 (see [[events-pipeline-design#E2E email-support store]] and
[[2026-08-29-e2e-email-support-store]]): the events-pipeline now persists a per-run, queryable
copy of every rendered email — full HTML and plaintext code — and serves it over a Lambda
Function URL. It is an **additional diagnostic channel, never an assertion channel**. Specs still
call `waitForEmailTo(...)` and still extract the OTP or reset code from the real Mailpit message;
the store only explains a failure after the fact. State the rule explicitly, because it is easy
to erode under pressure to turn a red spec green: **a spec that reads its OTP from the store
instead of the email stops proving delivery and is not a passing spec.**

**It distinguishes two failures that look identical from Mailpit's side.** Nothing recorded for a
run means the event was **lost** — the pipeline never rendered or sent it. Recorded, but absent
from Mailpit, means the mail is **late** — rendered and handed to SES, but not yet delivered to
the local inbox. Different causes, different fixes; conflating them wastes debugging time chasing
the wrong one. See [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] for why "late" is the
common case on this stack — Floci's own delivery cadence, not a pipeline defect.

## Adapting the three layers to a WebSocket surface (realtime-events)

A WebSocket API is not a REST endpoint — there is no per-request response to assert — but it is
still a **real gateway surface**, and the gateway-crossing test is still the one that matters, the
same principle [[events-pipeline-design#Realtime WebSocket fan-out (second output of TRACKING_STATUS_CHANGED)]]'s
producer, `functions/realtime-events/`, adapted from. See
[[2026-08-05-realtime-tracking-events-websocket-design#Testing]] for the full design.

1. **Unit/integration** (`functions/realtime-events/tests/`) — the authorizer (valid, expired,
   malformed, absent token), and the connect/disconnect handlers against a **real DynamoDB, not
   mocks** — per [[2026-08-05-realtime-tracking-events-websocket-design#2-dynamodb-as-the-connection-store]]
   and this repo's own prior lesson that a mocked persistence-path test can pass while the real
   schema or driver rejects the write.
2. **Pipeline-side** (`functions/events-pipeline/tests/websocket-publisher.test.ts`) — the fan-out
   logic with a simulated `410 Gone` response, asserting the dead connection's row is deleted and
   the rest of the batch is unaffected.
3. **Gateway E2E** (`e2e/tests/gateway/realtime-tracking.spec.ts`) — the only test that crosses
   Floci's WebSocket data plane end to end: real Cognito login → open the socket at
   `ws://localhost:4566/ws/{apiId}/{stage}?token=<jwt>` → create an order with
   `x-test-mode: true` → assert the **four** TestMode transitions arrive as WebSocket frames
   (`PROCESSING`, `SHIPPED`, `OUT_FOR_DELIVERY`, `DELIVERED` — `PLACED` is the status the tracking
   is *created* at, not a transition, and `TRACKING_STATUS_CHANGED` only fires from the transition
   path; see [[tracking-service-design#Events]]).

### Two mandatory negative tests for a WebSocket surface

Per [A rejection test is mandatory wherever a credential is verified](#a-rejection-test-is-mandatory-wherever-a-credential-is-verified)
above, generalized to a connection handshake instead of a login/verify endpoint:

- **An invalid token must be rejected at the handshake.** Same shape of risk this repo already
  hit once for HTTP login (see
  [A rejection test is mandatory wherever a credential is verified](#a-rejection-test-is-mandatory-wherever-a-credential-is-verified)):
  a `$connect` that accepts a bad or absent token regardless of validity would pass a
  happy-path-only suite with authentication effectively skipped. Only an explicit
  wrong-token-is-rejected test at the handshake rules that out — and it is the one gateway E2E
  test in this feature that currently **passes**; see the note below.
- **User A must not receive user B's events.** Two simultaneous connections from different users,
  asserting isolation — the only test that actually exercises the `by-cognito-sub` GSI scoping
  rather than merely asserting that *a* message arrived at all.

### Ordering caveat — assert the set, never the sequence

Messages are ordered per WebSocket connection (it runs over TCP), but the events-pipeline
processes SQS records in **batches with no cross-record ordering guarantee** (see
[[events-pipeline-design#Dispatch]]). A gateway E2E test for the TestMode transitions must
assert the **set** of `{PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED}` received — `PLACED` is
never in that set, since it is the tracking's creation status, not a transition — never a
specific sequence: a test that demands strict order is flaky independent of whether the feature
itself works.

> [!success] Resolved (2026-08-06) — the gap above was the assertion, not the feature
> The gap once documented here (two of three positive gateway E2E tests red, 0 frames received)
> turned out to be an incorrect assertion, not a delivery bug: the tests waited for **five**
> messages including `PLACED`, which `TRACKING_STATUS_CHANGED` never emits (`PLACED` is the
> tracking's creation status, not a transition — see the corrected count above). With the
> assertion corrected to the four real transitions, all three realtime gateway E2E tests pass
> and the full E2E suite is 83/83. The direct-Lambda controller probe mentioned in earlier
> versions of this note (authenticated socket → GSI row → event published for that sub → frame
> delivered with the correct payload) had already shown the feature itself worked; the count-only
> failure (`expected 5, got 4`) hid that the test helper needed to report *which* messages
> arrived, not just how many, before the real cause was visible — see
> [[2026-08-05-realtime-tracking-events-websocket-design#Debugging lesson — a count-only
> assertion hides which system is wrong]]. See also
> [[2026-08-05-realtime-tracking-events-websocket-design#Verification results (POC, 2026-08-05)]]
> and [[events-pipeline-design#Realtime WebSocket fan-out (second output of TRACKING_STATUS_CHANGED)]].
> Recorded here as a concrete instance of this convention's own rule: an unexplained red test is
> not swept into "pass eventually" — it is documented as outstanding until the root cause is
> found.

## Adapting the three layers to metrics publishing (non-HTTP surfaces)

Custom business metrics (see [[2026-08-12-custom-business-metrics-cloudwatch-design]] and
[[logging-context#Metrics — the third pillar, and why it does NOT go over OTLP]]) are published by
every service, but a metric publish is not an HTTP endpoint — there is no request/response to
assert and no gateway to route through. The three-layer rule is adapted the same way it was for
the events-pipeline and the WebSocket surface above:

1. **Unit** — the publishing helper in each service: correct namespace (`3MRAI`), correct metric
   name, and the **exact** dimension set. The dimension set is asserted literally (not through a
   builder or a partial match), because it is the part that silently breaks a dashboard per
   [[logging-context#Metrics — the third pillar, and why it does NOT go over OTLP]] gotcha (a).
2. **Integration** — publish against Floci with `PutMetricData`, then read back with
   `GetMetricData` **using the same dimension set the dashboard will use**. This is the layer that
   would have caught the dimension-aggregation gotcha during the original spike, and it carries one
   non-negotiable assertion:

   > [!warning] Assert a NON-EMPTY value, never merely `StatusCode: "Complete"`
   > Floci's silent-empty failure mode (gotcha (a)) returns `StatusCode: "Complete"` with an
   > **empty** `Values` list when the query's dimension set does not match what was published —
   > that is not an error response, it looks exactly like "query succeeded, nothing there yet." A
   > test that only checks the status code passes identically whether the metric arrived or the
   > query is silently wrong. The integration test must assert the returned value is present and
   > non-empty, not just that the call succeeded.

3. **Pipeline verification** — with the observability profile up, confirm the metric arrives in
   OpenObserve, under its prefixed/lowercased dimension names and sanitized stream name (gotcha
   (b)). Observe across **at least two** `collection_interval` windows, never one — a check whose
   duration equals the export period can pass or fail purely on where it lands in the cycle, per
   [[2026-08-12-custom-business-metrics-cloudwatch-design#Testing]] and this repo's own prior
   verify-across-a-full-cycle lesson. Derive the wait from the configured interval rather than
   hardcoding seconds.

**Gauge correctness is verified against the database**, not self-referentially: the published
value must equal a `COUNT(*)`/`GROUP BY` against a known fixture, and a gauge must be queried with
`max()`/`Maximum`, never `sum()`/`Sum` — summing a gauge across samples in one window reports a
multiple of the real count (gotcha (c)).

### A test must never assert a mock's own configured behaviour

Found three times independently during the events-pipeline milestone, each a false-green test
that proved nothing about the real system:

- A test configured a mock to reject with `TransientError`, then asserted the result was a
  rejection with `TransientError`. That is restating the mock's own setup, not testing the
  classification logic that is supposed to produce that outcome from a real failure.
- A test invalidated a **non-PII field** while asserting the error did not leak an email address
  — but the email in that fixture was valid and would never have appeared in the error at all,
  regardless of whether the leak-prevention logic worked. The assertion passed for a reason
  unrelated to the thing it claimed to verify.
- A test verified a bundle under Node 24, which sniffs module syntax and loads an ESM bundle
  fine — while the actual runtime target is Node 20 (`nodejs20.x`), which does not, and which is
  exactly why the Lambda is bundled as CommonJS in the first place (see
  [[events-pipeline-design]]). Testing only on the local Node version reported a false pass for a
  runtime-specific failure mode.

The common shape: each test's assertion was satisfiable by the test's own setup, independent of
whether the production code under test was correct. When writing a test, ask what would make it
fail — if the only thing that can make it fail is changing the test's own fixture or mock
configuration, it is not testing the system.

## A rejection test is mandatory wherever a credential is verified

**Rule:** any endpoint or flow that verifies a credential (a password, an OTP code, a token, a
signature) MUST have a dedicated test asserting the **wrong** credential is rejected, not just a
test asserting the right one is accepted. A suite that only exercises the happy path cannot
distinguish a working check from one that always returns true — both pass the same green suite.

This is not hypothetical: it is exactly how native Cognito `USER_AUTH` +
`PREFERRED_CHALLENGE=EMAIL_OTP` fails on Floci. The emulator accepts the request and **silently
returns tokens with no challenge issued at all** — a caller who only knows an email
authenticates as that user, with no code ever generated or checked. An E2E test asserting only
"tokens were issued" would pass green against that bypass; only a test asserting "a wrong code
is rejected" catches it. See [[2026-08-05-passwordless-otp-auth-design]] for the full evidence
and [[passwordless-auth-type]] for the shipped guard.

The passwordless OTP milestone shipped two such guards as mandatory, not optional, test cases —
both anti-false-PASS, both present at all three test layers (unit, internal E2E, gateway E2E):

- **A wrong OTP code is rejected** — `POST /v1/users/otp/verify` with an incorrect code returns
  `401 invalid_otp`, never tokens.
- **A `PASSWORDLESS` user cannot log in with a password** — `POST /v1/users/login` against a
  passwordless account returns the same generic `401 invalid_credentials` as a wrong password,
  for any guessed value, proving the service-side guard actually runs rather than the account
  being reachable because nobody happens to know its random password.

Generalized: wherever a design introduces a new way to prove identity or authorize an action,
the test suite needs both "the right credential works" and "a wrong credential is refused" — the
second is what makes the first mean something.

## E2E cleanup by tag

All three services expose a flag-guarded `e2e-cleanup` endpoint (Users `DELETE /v1/users/e2e-cleanup`,
Orders `DELETE /v1/orders/e2e-cleanup`, Tracking `DELETE /v1/trackings/e2e-cleanup`), and the E2E
harness's global teardown (`e2e/support/global-teardown.ts`) calls all three at the end of a run.
Each takes **no caller identity** — the harness's teardown runs once, globally, with no user
session — so ownership-by-caller cannot work here; instead, every service marks the rows a test
created with a `"E2E Source"` tag at write time, and the cleanup deletes by that tag.

A row is tagged only when the write request sent `x-e2e-source: true` **and** the service's own
`E2E_TESTING_ENABLED` flag was on — **both conditions are mandatory**. The conjunction is what stops
an untrusted client tagging its own rows so that someone else's teardown deletes them; the header
alone is never sufficient. The same two-part rule protects `test_mode`/`x-test-mode` (see
[[tracking-service-design#TestMode automatic progression]]). With the flag off, neither half of the
mechanism exists: nothing gets tagged, and (in Orders and Tracking) the cleanup route itself is
never mounted, so a caller sees `405` on that path rather than a `404` or a silently-empty `200`.
Every service implements the underlying delete as a soft-delete, per [[soft-delete]].

## E2E setup restocks the catalogue, not only teardown

Both harnesses (Playwright E2E and the Gatling load tests) now restock the product catalogue at
**setup**, not only at teardown (commit `ad4b153`). The call is `DELETE /v1/orders/e2e-cleanup` —
the same endpoint documented above — which restores stock to the seeded quantities and
invalidates the catalogue cache.

- **Teardown already restocked**, and its code comment records the incident that motivated it:
  all three products once reached zero stock and the suite began failing with *"no product with
  stock in the catalogue"* — including tests about ownership and carrier auth whose fixtures
  merely need to place an order first, with no direct interest in stock levels at all.
- **The hole teardown-only left:** teardown only runs when a suite finishes cleanly. A Ctrl-C, a
  timeout, or an early hard failure never reaches it, and the next run starts drained.
- **Load tests need it more, and this was measured, not assumed.** They deliberately send neither
  `x-e2e-source` nor `x-test-mode`, so their orders are untagged and `e2e-cleanup`'s tag-based
  delete can never touch them — seven probe orders
  returned `deleted: 0` every time. Their drain on the catalogue is therefore permanent and
  cumulative, run after run, until order creation fails for want of stock **instead of** under
  the contention the simulation exists to measure. That run still produces a number, and the
  number is wrong — the same failure shape as "verify both arms do equivalent work" from the
  performance-comparison lesson ([[2026-08-27-go-vs-python-performance]]), in a different
  costume: a result that looks like a measurement while actually measuring an artifact of the
  harness.
- **Both callers fail loudly.** An unreachable service, an unmounted route, or any non-200
  response from the restock call aborts the run before a single spec or virtual user executes
  (verified: exit 1). A setup step that cannot fail is not a step.
- **For Gatling it is a pnpm pre-step, not a scenario action.** The simulation runs on GraalVM
  with no process access, so the restock call cannot happen from inside a Gatling scenario body —
  and even if it could, anything inside a scenario runs **per virtual user**, which would reload
  stock mid-measurement and show up as its own row in the percentile tables rather than as setup.

## Related

- [[ADR-0010-cognito-auth]]
- [[ADR-0016-local-apigw-nginx-ecs]]
- [[local-dev]]
- [[2026-07-17-testing-layers-and-e2e-gateway-design]]
- [[2026-07-17-testing-layers-and-e2e-gateway]] — the implementation plan for the design above.
- [[events-pipeline-design]] — where the adapted three-layer treatment for a non-HTTP,
  SQS-triggered component is implemented.
- [[2026-08-03-events-pipeline-milestone-design]] — full detail on the adapted layers and the
  `batchItemFailures` test.
- [[2026-08-29-e2e-email-support-store]] — the implementation plan for the E2E email-support
  store described above.
- [[2026-08-29-the-emulator-was-the-ceiling-not-the-code]] — the investigation that motivated the
  store and the "lost vs. late" distinction it exists to make.
- [[orders/testing/index|Orders Testing]]
- [[users/testing/index|Users Testing]]
- [[tracking/testing/index|Tracking Testing]]
- [[soft-delete]] — the soft-delete-by-tag mechanism each service's `e2e-cleanup` endpoint uses.
- [[tracking-service-design]] — Tracking's `e2e-cleanup` endpoint and the `x-e2e-source`/
  `E2E_TESTING_ENABLED` conjunction, documented in full.
- [[2026-08-05-passwordless-otp-auth-design]] — the Floci `EMAIL_OTP` bypass that motivates the
  mandatory rejection-test rule above.
- [[2026-08-05-passwordless-otp-auth]] — the implementation plan that shipped both mandatory
  anti-false-PASS guards at all three test layers.
- [[passwordless-auth-type]] — the service-side login guard one of those guards verifies.
- [[2026-08-12-custom-business-metrics-cloudwatch-design]] — the metrics-adapted three-layer
  rule above, including the non-empty-value assertion the silent-empty Floci failure mode
  requires.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — a limit of this
  convention worth naming explicitly: none of its layers, however complete, is designed to
  catch a requirement that was specified in a brief and never implemented — only a
  requirement that was implemented incorrectly. A specified-but-dropped concurrency guard
  produced a fully green suite.
