---
title: Orders → Users gRPC calls authorized by a shared x-api-key
type: adr
area: orders
status: accepted
id: orders-grpc-api-key-authorization
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-08-26
tags: [type/adr, area/orders, status/accepted]
related:
  - "[[orders-service-design]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-14-orders-service-milestone]]"
  - "[[tracking-service-design]]"
  - "[[2026-08-25-account-deletion-design]]"
---

# Orders → Users gRPC calls authorized by a shared x-api-key

## Context

[[ADR-0003-grpc-inter-service]] establishes gRPC as the inter-service RPC protocol
but does not define an authorization scheme for it. The Orders Service milestone
design (2026-07-14) needed Orders' `POST /v1/orders` to call the Users gRPC
`GetUserById` (resolving the caller's Cognito sub to the internal `usr_` id), and
that call sits behind [[ADR-0010-cognito-auth]]'s user-facing gateway auth, not
inside it — it needed its own service-to-service authorization.

## Decision

A shared symmetric key, `GRPC_API_KEY`, identical on both Users and Orders:

- Travels in gRPC **metadata** under the key `x-api-key` — never in the message body
  and never the caller's Cognito JWT.
- **Users (server):** a gRPC server interceptor extracts `x-api-key` and compares it
  to `GRPC_API_KEY` using a **constant-time** comparison
  (`node:crypto timingSafeEqual`, guarded against length mismatch). Missing or
  mismatched key → `UNAUTHENTICATED` (gRPC code 16); the handler never runs.
- **Orders (client):** the generated `Grpc.Tools` client attaches `x-api-key` in the
  metadata of every call, reading `GRPC_API_KEY` from its own environment.
- Local value: a `local-dev-secret`-style constant in compose env (`local-dev-grpc-key`),
  not exposed outside the compose network. Production value is deferred to Secrets
  Manager, same as other secrets — see [[ADR-0007-secrets-parameter-store]].

## Consequences

- The gRPC surface is unreachable by anything that doesn't hold `GRPC_API_KEY`, even
  though it is not behind the public API Gateway/Cognito path.
- Both services must keep `GRPC_API_KEY` in sync — a mismatch fails closed
  (`UNAUTHENTICATED`), not open.
- This was originally a two-service (Users↔Orders) scheme; Tracking has since joined as a
  second gRPC client presenting the same `x-api-key` outbound to Users' `GetUserById`, using
  the identical mechanism (see [[tracking-service-design#gRPC — outbound client to Users]]).
  Users remains the only gRPC **server** validating the key. Whether a shared key still
  scales as more clients join, or a per-service credential becomes warranted, remains
  undecided — not revisited here.

> [!warning] Correction (2026-08-26) — Orders is no longer only a presenter of this key
> This ADR previously framed `GRPC_API_KEY` as something **Orders presents outbound** and
> **Users alone validates inbound**. That is no longer the complete picture: the account-deletion
> milestone added `DELETE /v1/orders/by-user`, an internal REST route (not gRPC) that Orders
> **validates inbound**, using the same `GRPC_API_KEY` secret and a constant-time comparison — the
> same mechanism, a different transport and a different direction. Users remains the only **gRPC**
> server validating the key; Orders is now additionally an **HTTP** server validating it, on a
> route reachable only from inside the network and absent from the API Gateway. See
> [[orders-service-design#Account-deletion cascade (internal)]] and
> [[2026-08-25-account-deletion-design]] for the full route design.

## Related

- [[2026-08-25-account-deletion-design]] — the account-deletion cascade that made Orders an
  inbound HTTP validator of `GRPC_API_KEY`, not merely an outbound presenter.
- [[orders-service-design]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-14-orders-service-milestone]]
- [[tracking-service-design]] — Tracking joined as a second gRPC client of the same `x-api-key`
  scheme, presenting it outbound to Users' `GetUserById` the same way Orders does.
