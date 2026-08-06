---
title: "Floci WebSocket API Gateway + DynamoDB support probe"
type: lesson
area: infra
status: active
created: 2026-08-06
updated: 2026-08-06
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
related:
  - "[[floci-sqs-lambda-docdb-support]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0017-floci-local]]"
  - "[[nginx-njs-x-user-id-injection]]"
  - "[[events-pipeline-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket-design]]"
  - "[[2026-08-05-realtime-tracking-events-websocket]]"
---

# Floci WebSocket API Gateway + DynamoDB support probe

Empirical findings from a throwaway POC (2026-08-05, outside Terraform — see
[[2026-08-05-realtime-tracking-events-websocket-design#Verification results (POC, 2026-08-05)]])
and from the subsequent implementation (2026-08-06,
[[2026-08-05-realtime-tracking-events-websocket]]) against Floci's WebSocket API Gateway and
DynamoDB support. Recorded so future realtime/WebSocket work on this repo doesn't re-derive them.
Companion to [[floci-sqs-lambda-docdb-support]] (SQS/Lambda/DocumentDB) and
[[floci-rds-apigw-limits]] (RDS/HTTP API Gateway) — this note covers the two AWS services those
two didn't: DynamoDB, and API Gateway's **WebSocket** protocol type specifically (not the HTTP
type both prior notes cover).

## Headline verdict

The realtime design (WebSocket API + REQUEST authorizer + DynamoDB, per
[[2026-08-05-realtime-tracking-events-websocket-design]]) is **viable on Floci as designed**. Every
piece the design depends on — the WebSocket data plane, `@connections` management calls, the
REQUEST authorizer's context propagation, and DynamoDB with a GSI — is genuinely implemented, not
stubbed. One local-only quirk remains scoped below (an undocumented URL shape, harmless once
known); the gateway E2E failure once reported here turned out to be an incorrect test assertion,
not a gap in the feature — see [Resolved: the gateway E2E "failure" was the assertion, not the
feature](#resolved-2026-08-06--the-gateway-e2e-failure-was-the-assertion-not-the-feature) below.

## What WORKS (verified, with the evidence)

**DynamoDB:** a table with a GSI, `PutItem`, `Query` by GSI, `DeleteItem`, and
`UpdateTimeToLive` all succeed. A GSI query with three seeded rows (two connections for one
Cognito sub, one for another) returned exactly the two belonging to the first sub — the per-user
isolation the design depends on, verified directly rather than assumed. `UpdateTimeToLive` is
accepted, but whether the background expiry sweep actually runs was **not** verified — this does
not matter here, because TTL in this design is a safety net, never the cleanup mechanism (see
[[2026-08-05-realtime-tracking-events-websocket-design#TTL is a safety net, not the cleanup mechanism]]).

**WebSocket data plane and `@connections`:** a real client connected and `PostToConnection`
delivered an actual frame — verified by reading the frame off the socket, not merely a 2xx from
the API call. `410 Gone` for a dead connection works exactly as the reactive-cleanup design
assumes (`GoneException`, HTTP 410), verified through the AWS SDK (boto3), not only raw HTTP.

**The REQUEST authorizer on `$connect` — the highest-risk item, and it passed.** Floci genuinely
invokes the authorizer and propagates its returned `context` intact to the `$connect` integration.
Evidence: three connection attempts produced three authorizer invocations; the authorizer received
the token correctly in `queryStringParameters`; a valid token yielded `HTTP 101 Switching
Protocols` while both a bad token and an absent token yielded `HTTP 403 Forbidden`; and the
`$connect` handler was invoked exactly once (only for the valid token), receiving
`requestContext.authorizer` with its custom context keys intact.

**`update-function-code` genuinely replaces code** on this emulator — verified with a marker
function during the JWT-issuer fix (below). It is not one of Floci's known silently-dropped update
APIs (contrast with [[floci-sqs-lambda-docdb-support]]'s Finding 3, where
`update-event-source-mapping` silently drops a field).

## Significant finding: the WebSocket authorizer does NOT inherit the HTTP API's claim-mapping limitation

This repo's prior finding — [[nginx-njs-x-user-id-injection]] — is that Floci's **HTTP** API
Gateway never maps JWT/authorizer claims to a header, which is why the local stack needs an
nginx+njs sidecar to decode the JWT and inject `x-user-id` itself. **That limitation does not
carry over to WebSocket APIs on Floci.** The mechanisms genuinely differ: a WebSocket REQUEST
authorizer returns a `context` object that the gateway propagates directly to the integration,
rather than the gateway mapping claims into a header the way the HTTP JWT authorizer would need
to. The fallback contemplated at design time — validating the token again inside the `$connect`
handler itself, in case the authorizer's context didn't survive — was not needed and was not
implemented, once this was verified.

## Undocumented local-only URL shapes

Two URL shapes, both required to make this design work against Floci, neither documented by
Floci and neither matching real AWS.

### Data-plane connect URL

```
ws://localhost:4566/ws/{apiId}/{stage}
```

**Not** the `restapis/<id>/$default/_user_request_/<path>` pattern this repo's HTTP API already
uses locally. Assuming the HTTP-style pattern applies here fails the connection with no obvious
error; the shape must be looked up and used as-is.

### Management API URL (`@connections`) — actively misleading failure mode

```
http://localhost:4566/execute-api/{apiId}/{stage}
```

so the full call is `POST /execute-api/{apiId}/{stage}/@connections/{connectionId}`. This prefix
is **not documented by Floci** and does not correspond to real AWS (where the endpoint is
`https://{apiId}.execute-api.{region}.amazonaws.com/{stage}`).

> [!warning] Wrong shapes fail as an S3 credentials problem, not a routing problem
> Five other plausible URL shapes were tried; all return **HTTP 400 with an S3 XML error body**
> (`<Error><Code>InvalidArgument</Code>`), because unrouted paths on `:4566` fall through to
> Floci's S3 handler — the same root cause behind the already-known quirk that odd API Gateway
> 404s come back as `NoSuchBucket`. One shape (`/ws/{apiId}/{stage}/@connections/...`) returns 403
> instead, which is even more convincingly wrong. An implementer hitting either would reasonably
> chase a credentials or permissions problem that does not exist — verify the endpoint shape
> first.

Verified through the AWS SDK with an `endpoint_url` override, not just raw HTTP — the pipeline
Lambda uses the SDK, so an HTTP-only check would have been a false green. Must be configured as an
SDK endpoint override for local runs only (`WS_MANAGEMENT_ENDPOINT`, generated per [[env-files]])
— production uses the real AWS endpoint.

## A Cognito JWT verifier must take its issuer from configuration, not derive it from the pool id

Found during implementation (Task 10 of [[2026-08-05-realtime-tracking-events-websocket]]), not
the original POC — worth stating plainly because the POC's authorizer never validated a real JWT,
it only echoed the token back, so this gap was invisible until real verification was wired in.

`aws-jwt-verify`'s top-level `CognitoJwtVerifier` derives **both** `issuer` and `jwksUri` purely
from `userPoolId`, unconditionally pointed at real AWS Cognito — there is no supported way to
override that derivation (the library spreads its own computed values last over whatever is
passed in). Floci's local user pool only ever exists in Floci, which stamps `iss` as
`http://localhost:4566/<pool-id>`; a verifier that assumes AWS-hosted Cognito can never fetch a
matching JWKS for it, so **every token — valid or garbage — fails identically**, which looks
exactly like "the authorizer works but nothing is ever authorized."

**Fix used:** the library's own documented escape hatch, the low-level `JwtRsaVerifier`, given an
explicit `issuer`/`jwksUri` sourced from **configuration** — `COGNITO_ISSUER`, generated from
Terraform's `module.cognito.issuer` output, the same value the REST API Gateway's native JWT
authorizer already consumes. A second, compounding obstacle: `aws-jwt-verify`'s default JSON
fetcher calls Node's `https` module directly and throws `Protocol "http:" not supported` for a
plain-HTTP JWKS URI — Floci serves its JWKS endpoint over plain HTTP locally (no TLS termination),
so a custom fetcher built on the global `fetch` (available on `nodejs20.x`+, no new dependency) is
required to reach it at all, scoped to `AWS_ENDPOINT_URL` being set so the real-AWS/HTTPS path is
untouched.

A related, easy-to-miss distinction while wiring this: the **issuer claim** to verify `iss`
against and the **JWKS fetch URL** are two different concerns that happen to share a host on real
AWS but not locally — Floci stamps `iss` as the host-facing `http://localhost:4566/<pool-id>`
(what the token itself carries), while `localhost` does not resolve to Floci from inside a Lambda
container; only the in-network `http://floci:4566` (`AWS_ENDPOINT_URL`) does. Fetching the JWKS
from the issuer URL directly fails with a bare `fetch failed`, independent of whether the
issuer/signature are otherwise valid.

## Resolved (2026-08-06) — the gateway E2E "failure" was the assertion, not the feature

Not a Floci-only finding — kept here because it sits squarely in the WebSocket surface this note
documents, and because ruling out Floci-emulator causes was part of the diagnostic work.

`e2e/tests/gateway/realtime-tracking.spec.ts` has three tests. The invalid-token rejection test
always passed. The two positive tests ("delivers all status transitions", "does not deliver one
user's events to another user") were previously reported red, failing with **0 frames received**.
A controller-run direct-Lambda probe had already verified the full chain works end to end
(authenticated socket → GSI row present → pipeline invoked for that sub → frame delivered with the
correct payload), and the `410 Gone` cleanup path was independently confirmed live by watching a
seeded row get deleted — so the delivery path itself was never the problem. Four hypotheses were
measured and ruled out along the way:

- Premature socket close — the socket survived the **full 75.3s** `waitForCount` timeout and
  closed only when the test gave up, not before.
- Cognito-sub mismatch — the sub stored by `$connect` and the sub published by Tracking in the
  same run are **identical**.
- GSI indexing lag — sampled at t=0.0s after a live connect, the GSI already showed the row.
  Immediate, not delayed.
- Stale env in Playwright — `playwright.config.ts` loads `.env.local.debug` explicitly, and its
  `WS_URL` matches the live API id for that run.

The real root cause was the tests' own expectation: they waited for **four** messages including
`SHIPPED`, but `TRACKING_STATUS_CHANGED` is published only from `update_tracking_status` (the
transition path) — `SHIPPED` is the status a tracking is *created* at (`create_tracking.py`), which
never calls it, so it is never pushed. A TestMode run therefore produces exactly **three**
transitions (`ON_THE_WAY`, `OUT_FOR_DELIVERY`, `DELIVERED`) and three pushes; see
[[tracking-service-design#Events]]. With the assertion corrected to three, both positive tests pass
and the full E2E suite is 83/83. The count-only assertion (`expected 4, got 3`) is what hid this —
it could not distinguish a dropped message from a wrong expectation, which is why the four
hypotheses above had to be ruled out one at a time before the real cause was visible. See
[[2026-08-05-realtime-tracking-events-websocket-design#Debugging lesson — a count-only assertion
hides which system is wrong]] and
[[events-pipeline-design#Realtime WebSocket fan-out (second output of TRACKING_STATUS_CHANGED)]].

## Probe hygiene

The design-time POC (WebSocket API, two Lambdas, a DynamoDB table) was created and torn down
**outside** Terraform, deliberately, to avoid Floci's known "second `terraform apply` fails"
quirk (see [[floci-rds-apigw-limits]] and [[ADR-0017-floci-local]]) while still exercising the
real emulator; the existing local stack was untouched.

## Related

- [[floci-sqs-lambda-docdb-support]] — the companion probe for SQS/Lambda/DocumentDB, same
  events-pipeline lineage.
- [[floci-rds-apigw-limits]] — the companion probe for RDS + the **HTTP** API Gateway, including
  the "only a from-scratch apply is reliable" rule this probe's own hygiene follows.
- [[floci-vs-ministack-spike-findings]]
- [[ADR-0017-floci-local]]
- [[nginx-njs-x-user-id-injection]] — the HTTP API claim-mapping limitation this note's WebSocket
  finding explicitly does NOT inherit.
- [[events-pipeline-design]] — the realtime fan-out this probe de-risked.
- [[2026-08-05-realtime-tracking-events-websocket-design]] — the design spec these findings back,
  including the full POC verification section.
- [[2026-08-05-realtime-tracking-events-websocket]] — the implementation plan; Task 10's fix round
  is where the JWT-issuer finding was made.
