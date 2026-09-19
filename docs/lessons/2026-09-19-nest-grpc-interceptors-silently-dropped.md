---
title: "Nest GrpcOptions silently drops interceptors — a wrong x-api-key returned user data"
type: lesson
area: users
status: active
created: 2026-09-19
updated: 2026-09-19
tags:
  - type/lesson
  - area/users
  - status/active
  - severity/high
related:
  - "[[2026-09-19-users-nestjs-migration-design]]"
  - "[[2026-09-19-users-nestjs-migration]]"
  - "[[grpc-context-activate-at-dispatch]]"
  - "[[users-service-design]]"
  - "[[ADR-0003-grpc-inter-service]]"
  - "[[testing]]"
---

# Nest GrpcOptions silently drops interceptors — a wrong x-api-key returned user data

## Finding

`@nestjs/microservices`' `GrpcOptions` type declares **no** `interceptors` key.
`server-grpc.js` builds the grpc-js server from the merged **`channelOptions`** alone
(`new grpcPackage.Server(options)`). Passing interceptors under a nested `server:` key —

```ts
{ transport: Transport.GRPC, options: { server: { interceptors: [...] } } }
```

— is dropped with **no warning**. The Nest process starts, every unit test that never
exercises a wrong key stays green, and a call bearing a **wrong** `x-api-key` returns the
user's data. That is an open authentication bypass that emits nothing in logs or startup.

Measured during the 2026-09-19 Users NestJS migration spike against the real
`proto/users.proto`. The load-bearing fix is to put the grpc-js interceptors on
`channelOptions`, which grpc-js actually reads — with a
`WORKAROUND(nestjs-microservices):` comment naming the symptom so the shape is not "tidied"
back to the intuitive spelling.

## Why every ordinary check missed it

- The type system accepts the wrong shape (or at least does not force the right one): there
  is no `interceptors` field on `GrpcOptions` to autocomplete toward `channelOptions`.
- Startup is successful either way — Nest never validates that an interceptor array was
  installed on the underlying `grpc.Server`.
- Handler tests that use a correct key (or that skip the transport) never observe the
  bypass. Only an explicit **wrong-key → UNAUTHENTICATED** assertion catches it.

## Guard

`services/users/tests/grpc/users-grpc.test.ts` carries two independent gates:

1. Trace continuity — the server span joins the caller's W3C `traceId` (JE-77
   `onReceiveHalfClose` activation still required; see [[grpc-context-activate-at-dispatch]]).
2. Wrong `x-api-key` → `UNAUTHENTICATED` — the auth-bypass canary for this exact drop.

Mutating either gate red then reverting confirmed neither is vacuous.

## How to apply

- When wiring `@nestjs/microservices` gRPC in this repo, put grpc-js interceptors on
  `channelOptions`, never under a `server:` nest that Nest's options type invites by
  analogy with other transports.
- Pair every gRPC auth interceptor with a negative test that sends a **wrong** credential
  and asserts rejection. A suite that only exercises the happy path cannot detect a silently
  dropped interceptor.
- Keep `api-key-interceptor.ts` / `grpc-tracing.ts` behaviour unchanged across framework
  migrations — the transport host changes; the security contract does not.

## Related

- [[2026-09-19-users-nestjs-migration-design]] — migration that adopted `@nestjs/microservices`.
- [[2026-09-19-users-nestjs-migration]] — plan DI-2 and the two gRPC gates.
- [[grpc-context-activate-at-dispatch]] — JE-77 activation point that must survive the Nest transport.
- [[users-service-design]] — Users gRPC surface.
- [[ADR-0003-grpc-inter-service]] — inter-service gRPC contract.
- [[testing]] — negative-path coverage for auth at the transport boundary.
