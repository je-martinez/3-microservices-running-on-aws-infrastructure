---
title: Two API keys, two trust domains — GRPC_API_KEY and TRACKING_CARRIER_API_KEY must never collapse
type: adr
area: tracking
status: accepted
id: tracking-two-api-keys
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-31
updated: 2026-07-31
tags: [type/adr, area/tracking, status/accepted]
related:
  - "[[tracking-service-design]]"
  - "[[grpc-api-key-authorization]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[logging-context]]"
---

# Two API keys, two trust domains — GRPC_API_KEY and TRACKING_CARRIER_API_KEY must never collapse

## Context

Tracking holds two key-based credentials that both look, superficially, like "an API key
Tracking uses for auth" — but they sit on opposite sides of the service and in opposite trust
domains:

- **`GRPC_API_KEY`** — an **outbound** credential. Tracking presents it as `x-api-key` gRPC
  metadata when it calls `users.v1.Users/GetUserById` to resolve a caller's Cognito sub to
  their internal `usr_` id. It is the same shared, internal secret Orders already presents to
  Users for the identical call — see [[grpc-api-key-authorization]]. Every holder is one of
  **our own services**.
- **`TRACKING_CARRIER_API_KEY`** — an **inbound** credential, validated by Tracking itself,
  presented by an **external third-party carrier/webhook** calling
  `PUT /v1/trackings/{orderId}/status` to simulate a delivery status update. The holder is
  **not one of our services** — it is handed to an outside vendor.

Tracking is the only service in the repo that is simultaneously a gRPC client of one
internal-only key and the direct validator of one externally-distributed key. That combination
makes it the one place a future implementer, reaching for "the API key," could plausibly wire
the wrong one into the wrong handler and have it work in a quick manual test (both are
strings compared against an env var) while being catastrophically wrong in production.

## Decision

`GRPC_API_KEY` and `TRACKING_CARRIER_API_KEY` are **two separate secrets, provisioned
separately, and never reused as each other**:

- `GRPC_API_KEY` is read only by the outbound gRPC client code that calls Users; it is never
  checked against anything arriving at Tracking's own REST surface.
- `TRACKING_CARRIER_API_KEY` is read only by the `PUT /v1/trackings/{orderId}/status` handler;
  it is never attached to any outbound call Tracking makes.
- Both are treated as rotatable secrets in Parameter Store, per
  [[ADR-0007-secrets-parameter-store]], not hardcoded values — but they are **separate**
  Parameter Store entries with separate rotation lifecycles, since the carrier key may need to
  rotate on a vendor-driven schedule independent of internal service credentials.
- Failed auth attempts against the carrier PUT endpoint are logged (without ever logging the
  key itself, per [[logging-context]]) — an endpoint validated with an externally-distributed
  key, reachable without a Cognito JWT, and capable of mutating delivery state is a larger
  attack surface than the rest of the service, and failed-attempt visibility is the cheapest
  available mitigation.

## Consequences

- If the two keys were ever collapsed into one value, the external carrier would hold a
  credential valid against Tracking's entire internal gRPC-client trust boundary — nothing
  stops that value from being reused elsewhere a shared secret is checked. Keeping them
  separate means a compromised or leaked carrier key exposes only the one REST endpoint it was
  scoped to.
- Rotating the carrier key (e.g. because a vendor relationship ends) never requires touching
  `GRPC_API_KEY` or coordinating with Users/Orders, and vice versa.
- Any new external integration Tracking gains in the future should default to its own
  dedicated key under this same reasoning, rather than reusing either existing one.

## Related

- [[tracking-service-design]] — full auth-scheme table (inbound and outbound) this decision
  formalizes.
- [[grpc-api-key-authorization]] — the shared internal `x-api-key` scheme `GRPC_API_KEY`
  belongs to; Tracking is a second client of it, alongside Orders.
- [[ADR-0003-grpc-inter-service]] — why the internal call is gRPC at all.
- [[ADR-0007-secrets-parameter-store]] — both keys' storage/rotation mechanism.
- [[logging-context]] — failed carrier-auth attempts are logged; the key value itself never is.
