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
updated: 2026-07-28
tags: [type/adr, area/orders, status/accepted]
related:
  - "[[orders-service-design]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[ADR-0007-secrets-parameter-store]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-14-orders-service-milestone]]"
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
- This is currently a two-service (Users↔Orders) scheme. If a third service needs the
  same gRPC gate, revisit whether a shared key still scales or a per-service credential
  is warranted — not decided here.

## Related

- [[orders-service-design]]
- [[ADR-0003-grpc-inter-service]]
- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-14-orders-service-milestone]]
