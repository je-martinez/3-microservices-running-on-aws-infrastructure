---
title: Realtime Tracking Events over WebSocket Design
type: spec
area: events-pipeline
status: accepted
created: 2026-08-05
updated: 2026-08-06
tags:
  - type/spec
  - area/events-pipeline
  - status/accepted
propagates-to:
  - "[[events-pipeline-design]]"
  - "[[tracking-service-design]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[terraform-modules]]"
related:
  - "[[user-id-vs-cognito-sub-ownership-key]]"
  - "[[env-files]]"
  - "[[ADR-0017-floci-local]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[events-pipeline-design]]"
  - "[[tracking-service-design]]"
  - "[[testing]]"
  - "[[logging-context]]"
  - "[[terraform-modules]]"
---

# Realtime Tracking Events over WebSocket Design

## Goal

Emit a realtime event to connected clients every time a tracking status changes, using AWS API
Gateway WebSocket APIs with Cognito authentication. Tracking already emits
`TRACKING_STATUS_CHANGED` to the shared SQS queue on every transition (see
[[tracking-service-design]]); this design adds a realtime delivery channel **alongside** the
existing email notification — it does not replace it.

## Approved decisions

Each of the following was chosen over stated alternatives during brainstorming; none is
reopened here.

### 1. Push from the existing events-pipeline Lambda

The WebSocket fan-out happens **inside** the existing `TRACKING_STATUS_CHANGED` handler in
`functions/events-pipeline/`, not in a separate broadcaster Lambda. The pipeline already has the
validated event, the `user_id`, and the `event_id` dedupe by the time that handler runs. A
separate consumer would require introducing SNS/EventBridge fan-out or a second queue that does
not exist today — SQS, as used in this repo, is point-to-point (see [[events-pipeline-design]]),
so a second independent consumer of the same event has no delivery mechanism without adding one
of those.

### 2. DynamoDB as the connection store

DynamoDB was chosen over DocumentDB and ElastiCache. This is a deliberate choice of the
canonical AWS reference pattern (WebSocket API + DynamoDB) over minimizing new surface area.
Recorded honestly: DocumentDB was the lower-surface option, since the pipeline already speaks
Mongo — but the deciding factor was that this repo exists to demonstrate recognizable AWS
patterns, and API Gateway WebSocket + DynamoDB is the pattern AWS itself documents for connection
management.

**Accepted consequence:** DynamoDB support in Floci is now **empirically verified** — see
[Verification results (POC, 2026-08-05)](#verification-results-poc-2026-08-05), item 1. This
was a prerequisite task at design time, not an assumption this design relied on silently, and
it has since been confirmed rather than merely assumed.

### 3. JWT in the query string on `$connect`

Clients connect to `wss://.../{stage}?token=<jwt>`. Rationale:

- WebSocket APIs support only **REQUEST** (Lambda) or **IAM** authorizers — never the native
  Cognito JWT authorizer. This is true in real AWS **and** in Floci; it is not a local
  divergence.
- A browser's `new WebSocket(url)` cannot set custom headers, so `Authorization: Bearer` only
  works for non-browser clients. The query string is the only place on `$connect` where a
  browser can put the token.

  This repo has **no frontend today** — the actual consumers will be the E2E harness and any
  test client, both of which could use a header. The header option was still rejected: a
  contract that cannot serve a browser is the wrong contract for a feature whose entire purpose
  is pushing updates to a user's screen, and switching later would be a breaking change to the
  connection handshake. This is a deliberate choice for a future client, not a constraint the
  present code imposes.

**Accepted risk:** the token appears in URLs and therefore potentially in logs. This is bounded
by the short lifetime of Cognito access tokens.

**Empirical confirmation (POC, 2026-08-05):** the POC authorizer logged the headers it actually
received on the WebSocket handshake — only `Sec-WebSocket-Key`, `Connection`,
`Sec-WebSocket-Version`, `Host`, and `Upgrade`. No `Authorization` header reaches the authorizer
on a WebSocket `$connect`, confirming the query string is the only viable transport for the
token. This decision now rests on observed behavior, not only on the protocol argument above —
see [Verification results (POC, 2026-08-05)](#verification-results-poc-2026-08-05), item 3.

**Rejected alternative:** authenticating in a first message after an anonymous `$connect`. This
was rejected because it adds a connection state machine (anonymous → authenticated) and an
anonymous-connection surface that has to be tracked, timed out, and reasoned about — complexity
the query-string approach avoids entirely.

### 4. Implicit subscription by user

Connecting to the socket **is** subscribing to your own tracking events. There is no
`subscribe`/`unsubscribe` protocol and no per-`order_id` subscription. This was rejected because
it would add routes, subscription state, and an ownership check on `order_id` — a control that is
easy to get wrong — purely to save bandwidth on events the user is already entitled to see. A
user's own connection receiving all of their own tracking events is not an overexposure; it is
the minimum useful behavior.

### 5. New `functions/realtime-events/` package

A new package, sibling of `functions/events-pipeline/`, owns connection lifecycle — not extra
entrypoints bolted onto the pipeline package. The pipeline has a sharply defined identity today
(one Lambda, one queue, dispatch by type) and [[events-pipeline-design]] documents it that way;
connection lifecycle (`$connect`/`$disconnect`, an authorizer) is a different domain with a
different trigger (API Gateway, not SQS).

**Accepted consequence:** the DynamoDB connections table ends up with two logical writers — the
connect/disconnect handlers write and delete rows, and the events-pipeline Lambda deletes dead
rows on a `410 Gone` from `PostToConnection`. This is acceptable as long as the schema is
documented in exactly one place: this spec (see [Data model](#data-model--websocket_connections-table)).

### 6. New `infra/modules/api-gateway-ws/` module

A new Terraform module, not an `enable_websocket` flag on the existing
`infra/modules/api-gateway/`. A WebSocket API is a **separate** `aws_apigatewayv2_api`
(`protocol_type = "WEBSOCKET"`) — AWS does not allow mixed protocols in one API — and it shares
no resources, variables, or locals with the HTTP module. The existing module is built around a
`local.routes` map with an `auth` boolean, per-route `HTTP_PROXY` integrations (a Floci
workaround — see [[tracking-service-design#Gateway routing (existing module, not a new one)]]),
and a JWT authorizer; none of those shapes apply to a WebSocket API, whose integrations are
`AWS_PROXY` to Lambda and whose only usable authorizer type is REQUEST.

## Architecture

Two paths meeting at DynamoDB.

**Connection lifecycle path:**

```
client
  │  wss://.../{stage}?token=<jwt>
  ▼
$connect route
  │
  ▼
REQUEST authorizer ── validates the Cognito JWT ──► Allow policy, context.cognito_sub
  │
  ▼
connect handler ── PUTs {connection_id, cognito_sub} into DynamoDB
```

```
client closes / drops
  │
  ▼
$disconnect route
  │
  ▼
disconnect handler ── DELETEs the row by connection_id
```

**Event path:**

```
Tracking status transition
  │
  ▼
SQS (existing, unchanged)
  │
  ▼
events-pipeline Lambda
  │
  ▼
TRACKING_STATUS_CHANGED handler
  ├──► (a) render + SES email (existing, unchanged)
  └──► (b) Query DynamoDB GSI by-cognito-sub → PostToConnection per connection
             │
             └── 410 Gone on a connection → delete that row, continue with the rest
```

## Components

### New package: `functions/realtime-events/`

Three entrypoints, sibling of `functions/events-pipeline/`. Built the same way — esbuild →
single CommonJS bundle — for the same reason documented in [[events-pipeline-design]]: the
`nodejs20.x` runtime resolves an extension-less `.js` with no adjacent `package.json` as
CommonJS, and plain `tsc` leaves `#` subpath imports unresolved at runtime.

| Entrypoint | Route | Responsibility |
|---|---|---|
| `authorizer` | `$connect` REQUEST authorizer | Reads `token` from `queryStringParameters`, verifies signature and expiry against the Cognito JWKS, and returns an Allow policy with `context.cognito_sub`. Any failure returns Deny. |
| `connect` | `$connect` | Writes `{connection_id, cognito_sub, connected_at, ttl}` to DynamoDB. **`cognito_sub` comes from `requestContext.authorizer.cognito_sub`, never from the query string** — the authorizer is the only component that validated the token, so it is the only trustworthy source of the identity that gets persisted. |
| `disconnect` | `$disconnect` | Deletes the row by `connection_id`. |

### `functions/events-pipeline/`: one addition

A WebSocket publisher that the `TRACKING_STATUS_CHANGED` handler calls **after** sending the
email, following the pipeline's existing producer policy of log-and-swallow, never re-raise (see
[Error handling](#error-handling)).

### Infra

- `infra/modules/api-gateway-ws/` — the WebSocket API, its stage, the REQUEST authorizer, the
  three routes (`$connect`, `$disconnect`, `$default`), and their `AWS_PROXY` integrations.

> [!note] `$default` is declared, not omitted — and it rejects
> Under [decision 4](#4-implicit-subscription-by-user) the channel is server-to-client only: a
> client never needs to send anything. `$default` is still declared, and it responds with an
> error rather than being left unrouted. Omitting it would make an inbound message vanish
> silently — a client that wrongly believes it can subscribe, or send a heartbeat the server
> does not implement, would get no signal at all that its message went nowhere. Declaring the
> route costs one entry and turns a silent no-op into an explicit rejection. It is served by the
> `disconnect` entrypoint's bundle or a trivial fourth handler; either way it performs no
> connection-state mutation.
- `infra/modules/dynamodb/` — the connections table (see [Data model](#data-model--websocket_connections-table)).

> [!important] The existing `infra/modules/lambda/` module cannot be reused here
> `infra/modules/lambda/` is coupled to SQS: it exposes `queue_arn` and `batch_size` as inputs
> and creates an `aws_lambda_event_source_mapping`. The three `realtime-events` functions are
> invoked by API Gateway, not by a queue — there is no event source mapping to create for them.
>
> The decision is to declare these three Lambda resources **directly inside**
> `api-gateway-ws`, alongside the routes that invoke them, rather than making the event source
> mapping optional in the shared `lambda/` module. This keeps `lambda/` meaning "SQS-consumer
> Lambda" instead of becoming a generic Lambda wrapper with conditional branches for shapes it
> was never designed around, and it keeps these three functions colocated with the API whose
> lifecycle they share exactly (see [[terraform-modules]]).

## Data model — `websocket_connections` table

| Attribute | Type | Role |
|---|---|---|
| `connection_id` | string | Partition key. The API Gateway `connectionId`. |
| `cognito_sub` | string | GSI partition key (`by-cognito-sub`). The `sub` claim from the JWT. |
| `connected_at` | number | Epoch timestamp, diagnostics only. |
| `ttl` | number | Epoch expiry. Safety net only — see below. |

### Why the attribute is named `cognito_sub`, not `user_id`

The `$connect` authorizer holds only the JWT; resolving the internal `usr_` id would put a gRPC
call to Users on the critical path of every connection, which this design does not accept. But
the event envelope's `user_id` (see [[events-pipeline-design#Data Model]]) **is** the internal
`usr_` id, read from the persisted tracking row (see [[tracking-service-design#Events]]).
Querying the GSI with the internal id against rows keyed by `cognito_sub` would **return
nothing, silently** — exactly the failure [[user-id-vs-cognito-sub-ownership-key]] documents for
Tracking's own REST reads.

Naming the attribute `cognito_sub` rather than `user_id` makes the constraint visible at the call
site: an implementer holding a `usr_` id sees an attribute name that plainly does not match,
instead of a `Query` that returns zero rows with no error at all. The mismatch is a compile-time
question ("which value do I have?") rather than a silent runtime bug.

### This design touches Tracking

The event envelope already carries an optional `author.cognito_sub`
(see [[events-pipeline-design#The envelope's `author` object]]). Tracking must populate it on
`TRACKING_STATUS_CHANGED` — the tracking row already has the `cognito_sub` column (see
[[tracking-service-design#`Tracking`]]) — and the events-pipeline queries the GSI with that value.
Stated plainly because a first reading of "add a realtime channel to the pipeline" suggests only
the consumer changes: it does not. Tracking's publisher needs a small, explicit change to carry
`author.cognito_sub` on this event type.

### TTL is a safety net, not the cleanup mechanism

Real cleanup is reactive: `PostToConnection` returns `410 Gone` for a connection that no longer
exists, and the events-pipeline deletes that row at the moment it observes the 410. DynamoDB TTL
deletes items within a window of up to 48 hours after expiry, so it cannot serve as the primary
cleanup path. Floci accepts the `UpdateTimeToLive` API call (see
[Verification results (POC, 2026-08-05)](#verification-results-poc-2026-08-05), item 1), but
whether its background expiry sweep actually runs was not verified — which does not matter here,
since this design never depended on TTL for the primary cleanup path in the first place.

## Error handling

| Situation | Handling |
|---|---|
| Invalid, expired, or absent JWT on `$connect` | Authorizer returns Deny; the handshake fails. The client is not told why — deliberate, to avoid giving an unauthenticated caller a signal about which failure mode occurred. |
| `PostToConnection` returns `410 Gone` | Delete the connection row, continue processing the rest of the connections for this event. Not treated as an event-processing error. |
| `PostToConnection` returns any other error | Log and continue with the rest of the connections. |
| Total WebSocket push failure (e.g. DynamoDB query itself fails) | Log and swallow. The event still reaches `COMPLETED` if the email was sent — see [[events-pipeline-design#Status Machine]]. |
| User has no open connections | Normal. The GSI query returns empty and nothing else happens. |

**Governing rule: the WebSocket fan-out must never change the outcome of event processing.** The
email is the durable notification; the WebSocket push is an opportunistic enhancement layered on
top of it. Failing the event and letting SQS retry the whole record would send a **second** email
for an already-notified transition — trading a realtime-delivery failure for a duplicate email,
exactly the trade the pipeline's existing producer/publish-failure policy already rejects for all
four current producers (see [[events-pipeline-design#Producers and their publish-failure policy]]).

A **partially** failed push is not a failure at all: three tabs open, one dead — the other two
receive the event and the dead connection's row is cleaned up as a side effect, not treated as an
error to report.

## Testing

Per [[testing]], adapted the way [[events-pipeline-design]] already adapts it: there is no HTTP
endpoint here in the REST sense, but there is a real gateway surface (the WebSocket API), and the
gateway-crossing test is still the one that matters.

### Unit / integration (`functions/realtime-events/`)

- Authorizer: valid token, expired token, malformed token, absent token.
- Connect and disconnect handlers against a **real DynamoDB, not mocks** — this repo has direct
  experience of mocked tests passing while the real schema or driver rejects the write; a
  connection-store write path is exactly the kind of persistence path that must be verified
  against the genuine store.

### Pipeline-side

- The fan-out logic with a simulated `410 Gone` response, asserting the corresponding row is
  deleted and the rest of the batch is unaffected.

### Gateway E2E — the test that matters

The only test that crosses Floci's WebSocket data plane end to end:

1. Real Cognito login to obtain a JWT.
2. Open the socket at `ws://localhost:4566/ws/{apiId}/{stage}?token=<jwt>`.
3. Create an order with `x-test-mode: true`.
4. Assert **three** messages arrive: `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`.

Three, not four, and **not one**, because [[tracking-service-design#Events]] is explicit that
there is no suppression — every successful *transition* emits, `DELIVERED` included. But
`SHIPPED` is not a transition: it is the status a tracking is *created* at (see
[[tracking-service-design#TestMode automatic progression]]'s table, `t=0s SHIPPED (record
created)`). `TRACKING_STATUS_CHANGED` is published only from `update_tracking_status`
(`services/tracking/src/features/tracking/commands/update_status.py`), the transition path — the
creation path (`create_tracking.py`) never calls it. TestMode's three automatic advances
(`ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`) each go through `update_tracking_status`, so each
produces one event and one push; the initial `SHIPPED` write does not. Verified empirically by a
live gateway E2E run: the client received exactly `ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`
— never `SHIPPED`.

### Two mandatory negative tests

A false green here would be invisible without them:

- **An invalid token must be rejected at the handshake.** This repo has a documented precedent
  (see [[2026-08-05-passwordless-otp-auth-design|the passwordless OTP design]]) where Floci
  accepted an auth flow and returned tokens with **no challenge at all** — a
  happy-path-only test would have passed with authentication entirely skipped. The equivalent
  risk here is a `$connect` that succeeds regardless of the token; only an explicit rejection
  test rules it out.
- **User A must not receive user B's events.** Two simultaneous connections from different users,
  asserting isolation — the only test that actually exercises the `cognito_sub` scoping rather
  than merely asserting that *a* message arrived.

### Ordering note

Messages are ordered per connection, since WebSocket runs over TCP. But the events-pipeline
processes SQS records in batches with no cross-record ordering guarantee (see
[[events-pipeline-design#Dispatch]]). Tests must assert the **set** of the three transitions
received (`ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED` — `SHIPPED` is never one of them, see
[Gateway E2E — the test that matters](#gateway-e2e--the-test-that-matters) above), not a specific
sequence — a test that demands strict order will be flaky independent of whether the feature
works.

### Debugging lesson — a count-only assertion hides which system is wrong

While the four-transition assertion above was still in the spec, the gateway E2E test failed with
only `expected 4 messages, got 3`. That failure is **indistinguishable** between two very
different root causes: the fan-out silently dropping one of four legitimate pushes (a real bug in
`functions/realtime-events/` or the pipeline's WebSocket publisher), or the expectation itself
being wrong (this note's original four-transition error). A count-only assertion cannot tell you
which.

The test helper now reports **which** messages arrived, not just how many —
`e2e/support/ws-client.ts`'s collector surfaces the actual set of statuses received, so a failure
reads as `expected {ON_THE_WAY, OUT_FOR_DELIVERY, DELIVERED}, got {ON_THE_WAY, OUT_FOR_DELIVERY,
DELIVERED, SHIPPED}` (or a genuine drop) instead of a bare number. That is what made this error
diagnosable at all: the set showed `SHIPPED` never arriving, which is what led to checking
[[tracking-service-design#Events]]'s own TestMode table and finding the assertion, not the system,
was wrong. **Generalized rule: any test asserting "N things happened" should assert or at least
log *which* N, not only the count** — a count-only failure collapses two unrelated failure modes
(the system under test, and the test's own expectation) into one indistinguishable signal.

## Verification results (POC, 2026-08-05)

These were verified empirically against the running local Floci environment via a throwaway
POC — a WebSocket API, two Lambdas, and a DynamoDB table, all created and torn down **outside**
Terraform, so the local environment's persistent state was never touched. That was a deliberate
constraint, not an oversight: it sidesteps Floci's known "second `terraform apply` fails" quirk
(see [[ADR-0017-floci-local]]) while still exercising the real emulator. The numbering below is
kept from the earlier risk list so existing cross-references still resolve.

1. **DynamoDB on Floci — VERIFIED.** A table with a GSI, `PutItem`, `Query` by the
   `by-cognito-sub` GSI, `DeleteItem`, and `UpdateTimeToLive` all succeed. Critically, the GSI
   query with three seeded rows (two connections for `sub-user-1`, one for `sub-user-2`) returned
   exactly the two belonging to `sub-user-1` — the per-user isolation this design depends on,
   verified directly rather than assumed. TTL: `UpdateTimeToLive` is accepted, but whether the
   background expiry sweep actually runs was **not** verified — which does not matter, because
   the design only ever treats TTL as a safety net, never the cleanup mechanism (see
   [TTL is a safety net](#ttl-is-a-safety-net-not-the-cleanup-mechanism)).

2. **The WebSocket data plane and `@connections` — VERIFIED, with an important undocumented
   detail.** A real client connected at `ws://localhost:4566/ws/{apiId}/{stage}`, and
   `PostToConnection` delivered an actual frame to that client — verified by reading the frame
   off the socket, not merely by a 2xx from the API call. `410 Gone` for a dead connection also
   works exactly as the cleanup path assumes (`GoneException`, HTTP 410), verified through the
   AWS SDK (boto3), not only raw HTTP. The undocumented detail is the management API's URL shape
   on Floci — see [Floci local URL shapes](#floci-local-url-shapes) below.

3. **The REQUEST authorizer on `$connect` — VERIFIED; this was the highest-risk item, and it
   passed.** Floci genuinely invokes the authorizer and propagates its returned `context` intact
   to the `$connect` integration. Evidence: three connection attempts produced three authorizer
   invocations; the authorizer received the token correctly in `queryStringParameters`; a valid
   token yielded `HTTP 101 Switching Protocols` while both a bad token and an absent token
   yielded `HTTP 403 Forbidden`; and the `$connect` handler was invoked exactly once (only for
   the valid token), receiving `requestContext.authorizer` =
   `{"cognito_sub":"sub-goodtoken","poc_marker":"CONTEXT_SURVIVED"}` with its custom keys intact.

   **Significance:** this repo's prior finding that Floci's **HTTP** API Gateway never maps
   JWT/authorizer claims to a header (per [[nginx-njs-x-user-id-injection]]) does **not** carry
   over to WebSocket APIs. The mechanisms genuinely differ — the WebSocket authorizer returns a
   context object that the gateway propagates, rather than the gateway mapping claims into a
   header. **The fallback contemplated earlier — validating the token inside the `$connect`
   handler itself — is not needed and should not be implemented.**

### Floci local URL shapes

Two undocumented local-only URL shapes, both required to make this design work against Floci.

#### Data-plane connect URL

Floci serves the WebSocket data plane at `ws://localhost:4566/ws/{apiId}/{stageName}` — this is
**not** the `restapis/<id>/$default/_user_request_/<path>` pattern this repo's HTTP API already
uses locally. Assuming the HTTP-style pattern applies here fails the connection with no obvious
error; the WebSocket local URL must be looked up and used as-is, per [[ADR-0017-floci-local]]'s
general local-emulator posture of verifying rather than assuming AWS-equivalence.

#### Management API URL (`@connections`) — new finding

The `@connections` management API (used by `PostToConnection`, `GetConnection`, and
`DeleteConnection`) lives on Floci at:

```
http://localhost:4566/execute-api/{apiId}/{stage}
```

so the full call is `POST /execute-api/{apiId}/{stage}/@connections/{connectionId}`.

- This prefix is **not documented by Floci** and does not correspond to real AWS (where the
  endpoint is `https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`). It must be
  configured as an SDK endpoint override for local runs only — production uses the real AWS
  endpoint, so this belongs in the generated env files per [[env-files]], never hardcoded.
- **The failure mode is actively misleading, which is why this is worth documenting.** Five
  other plausible URL shapes were tried; they all return **HTTP 400 with an S3 XML error body**
  (`<Error><Code>InvalidArgument</Code>`), because unrouted paths on `:4566` fall through to
  Floci's S3 handler — the same root cause behind the already-known quirk that odd API Gateway
  404s come back as `NoSuchBucket`. An implementer hitting this would reasonably chase a
  credentials or permissions problem that does not exist. One shape
  (`/ws/{apiId}/{stage}/@connections/...`) returns 403 instead, which is even more convincingly
  wrong.
- Verified through the AWS SDK with an `endpoint_url` override, not just raw HTTP — the pipeline
  Lambda will use the SDK, so an HTTP-only check would have been a false green.

## Out of scope (YAGNI)

- No `subscribe`/`unsubscribe` protocol or per-`order_id` subscription — see decision 4 above.
- No fallback broadcaster Lambda, SNS, or EventBridge fan-out — see decision 1 above.
- No alternate connection store (DocumentDB, ElastiCache) — see decision 2 above.
- No header-based `Authorization: Bearer` path for `$connect` — the query-string token is the
  only mechanism this design implements, since it is the only one that works for a browser
  client.

## Related

- [[events-pipeline-design]] — the existing Lambda, dispatch map, envelope shape
  (`author.cognito_sub`), and producer publish-failure policy this design extends with the
  WebSocket fan-out.
- [[tracking-service-design]] — the `TRACKING_STATUS_CHANGED` producer, its `Tracking.cognito_sub`
  column, and TestMode's three-transition progression the gateway E2E test relies on (`SHIPPED` is
  the creation state, not a transition — see
  [Gateway E2E — the test that matters](#gateway-e2e--the-test-that-matters)).
- [[user-id-vs-cognito-sub-ownership-key]] — the ADR this design's `cognito_sub`-not-`user_id`
  attribute naming is a direct application of.
- [[env-files]] — the generated-env-file convention the new `realtime-events` package and
  `api-gateway-ws`/`dynamodb` modules follow for connection strings, queue URLs, and table names.
- [[ADR-0017-floci-local]] — the local-emulator posture (verify, don't assume AWS-equivalence)
  underlying every item in
  [Verification results (POC, 2026-08-05)](#verification-results-poc-2026-08-05).
- [[nginx-njs-x-user-id-injection]] — the repo's prior finding that Floci's HTTP API Gateway never
  maps JWT claims to headers; verification item 3 confirms this does not carry over to WebSocket
  APIs.
- [[testing]] — the three-layer test convention this design adapts for a non-REST, WebSocket
  gateway surface.
- [[logging-context]] — governs what the connect/disconnect handlers and the pipeline's WebSocket
  publisher may log (no tokens, no plaintext email).
- [[terraform-modules]] — the module inventory the new `api-gateway-ws` and `dynamodb` modules
  join, and the reasoning for why `lambda/` is not reused for these three functions.
