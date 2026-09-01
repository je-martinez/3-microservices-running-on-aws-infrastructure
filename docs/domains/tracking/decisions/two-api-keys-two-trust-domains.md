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
updated: 2026-08-27
tags: [type/adr, area/tracking, status/accepted]
related:
  - "[[tracking-service-design]]"
  - "[[grpc-api-key-authorization]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[logging-context]]"
  - "[[2026-08-25-account-deletion-design]]"
  - "[[2026-08-27-tracking-go-migration-design]]"
---

# Two API keys, two trust domains — GRPC_API_KEY and TRACKING_CARRIER_API_KEY must never collapse

## Context

Tracking holds two key-based credentials that both look, superficially, like "an API key
Tracking uses for auth" — but they sit on opposite sides of the service and in opposite trust
domains:

- **`GRPC_API_KEY`** — an **internal, symmetric** credential shared by every one of our own
  services. Tracking presents it as `x-api-key` gRPC metadata when it calls
  `users.v1.Users/GetUserById` to resolve a caller's Cognito sub to their internal `usr_` id — the
  same shared secret Orders already presents to Users for the identical call — see
  [[grpc-api-key-authorization]]. Every holder is one of **our own services**.
  >
  > **Correction (2026-08-26):** this decision originally described `GRPC_API_KEY` as purely
  > **outbound** for Tracking — something it only ever sends, never validates. That stopped being
  > true when the account-deletion milestone added `DELETE /v1/trackings/by-user`, an internal
  > REST route Tracking itself validates the same key **inbound** on (via `RequireInternalKey`),
  > the same secret and mechanism, a different transport and direction. Orders gained the identical
  > inbound-validation role on its own `DELETE /v1/orders/by-user` — see
  > [[orders-service-design#Account-deletion cascade (internal)]] and
  > [[tracking-service-design#Account-deletion cascade (internal)]]. `GRPC_API_KEY` being
  > internal and symmetric is exactly why this is not a contradiction: a service holding it can be
  > both a sender and a validator, as long as every holder is still one of our own services — the
  > property that matters for this ADR's decision below.
- **`TRACKING_CARRIER_API_KEY`** — an **inbound** credential, validated by Tracking itself,
  presented by an **external third-party carrier/webhook** calling
  `PUT /v1/trackings/{orderId}/status` to simulate a delivery status update. The holder is
  **not one of our services** — it is handed to an outside vendor.

Tracking is the only service in the repo that is simultaneously a client **and** a validator of
`GRPC_API_KEY`, **and** the direct validator of the externally-distributed
`TRACKING_CARRIER_API_KEY`. That combination — now three roles across two secrets, corrected
2026-08-26 from the original two roles across two secrets — makes it the one place a future
implementer, reaching for "the API key," could plausibly wire the wrong one into the wrong
handler and have it work in a quick manual test (all are strings compared against an env var)
while being catastrophically wrong in production.

## Decision

`GRPC_API_KEY` and `TRACKING_CARRIER_API_KEY` are **two separate secrets, provisioned
separately, and never reused as each other**:

- `GRPC_API_KEY` is read by the outbound gRPC client code that calls Users **and**, since the
  account-deletion milestone (2026-08-26), validated inbound by `RequireInternalKey` on
  `DELETE /v1/trackings/by-user` — see
  [[tracking-service-design#Account-deletion cascade (internal)]]. It is still never checked
  against Tracking's Cognito-authenticated REST surface (the reads, `init-tracking`) or the
  carrier PUT endpoint — those two keep their own schemes.
- **`RequireCarrierKey` and `RequireInternalKey` are two separate functions**
  (`services/tracking-go/internal/adapter/http/auth.go`) living side by side, rather than one
  helper parameterized by which key to check — one function per trust domain makes the
  wrong-key mistake structurally harder to make by accident. They share only the rejection
  path, never the secrets.
- `TRACKING_CARRIER_API_KEY` is read only by the `PUT /v1/trackings/{orderId}/status` handler;
  it is never attached to any outbound call Tracking makes, and it is never accepted on the
  internal `by-user` route above.
- Both are treated as rotatable secrets in Parameter Store, per
  [[ADR-0007-secrets-parameter-store]], not hardcoded values — but they are **separate**
  Parameter Store entries with separate rotation lifecycles, since the carrier key may need to
  rotate on a vendor-driven schedule independent of internal service credentials.
- Failed auth attempts against the carrier PUT endpoint **and** the internal `by-user` cascade
  route are logged (without ever logging the key itself, per [[logging-context]]) — the carrier
  endpoint is validated with an externally-distributed key and reachable without a Cognito JWT,
  and the cascade route is a mass soft-delete surface, the widest blast radius in this service;
  both are larger attack surfaces than the rest of the service, and failed-attempt visibility is
  the cheapest available mitigation for either.

## Consequences

- If the two keys were ever collapsed into one value, the external carrier would hold a
  credential valid against Tracking's **entire** internal trust boundary — including the mass
  soft-delete cascade route, not merely the outbound gRPC call this ADR originally scoped the
  risk to. Nothing stops that value from being reused elsewhere a shared secret is checked.
  Keeping them separate means a compromised or leaked carrier key exposes only the one REST
  endpoint it was scoped to.
- Rotating the carrier key (e.g. because a vendor relationship ends) never requires touching
  `GRPC_API_KEY` or coordinating with Users/Orders, and vice versa.
- Any new external integration Tracking gains in the future should default to its own
  dedicated key under this same reasoning, rather than reusing either existing one.

## Related

- [[2026-08-25-account-deletion-design]] — the account-deletion cascade that made
  `GRPC_API_KEY` something Tracking validates inbound (on `DELETE /v1/trackings/by-user`), not
  merely presents outbound.
- [[tracking-service-design]] — full auth-scheme table (inbound and outbound) this decision
  formalizes.
- [[grpc-api-key-authorization]] — the shared internal `x-api-key` scheme `GRPC_API_KEY`
  belongs to; Tracking is a second client of it, alongside Orders.
- [[ADR-0003-grpc-inter-service]] — why the internal call is gRPC at all.
- [[ADR-0007-secrets-parameter-store]] — both keys' storage/rotation mechanism.
- [[logging-context]] — failed carrier-auth attempts are logged; the key value itself never is.
- [[2026-08-27-tracking-go-migration-design]] — the Go port that carried this decision forward
  unchanged; `RequireCarrierKey`/`RequireInternalKey` are its two-functions-per-trust-domain
  implementation.
