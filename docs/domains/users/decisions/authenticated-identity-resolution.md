---
title: Authenticated identity resolution — findByIdOrCognitoSub
type: adr
area: users
status: accepted
id: users-identity-resolution
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/users, status/accepted]
related:
  - "[[users-service-design]]"
  - "[[ADR-0010-cognito-auth]]"
  - "[[2026-07-11-authenticated-identity-resolution-design]]"
  - "[[2026-07-11-byidorcognitosub]]"
---

# Authenticated identity resolution — findByIdOrCognitoSub

## Context

An authenticated `GET /v1/users/me` returned **404 `not_found`** even with a valid
token. Two independent gaps were isolated (verified live against Floci):

- **Gap 1** — nothing injects `x-user-id` from the JWT at the gateway (deferred; see
  [[ADR-0017-floci-local]] for the eventual nginx+njs fix).
- **Gap 2** — even when the header carries the Cognito `sub`, the lookup queried
  `where: { id }` only. The JWT carries the `sub`, which lives in the `cognitoSub`
  column, not `id`, so the query never matched.

This decision addresses **Gap 2 only**: making the identity lookup accept either
identifier. It does not touch header injection, the gateway, or infra.

## Decision

Resolve a user by their prefixed `usr_` id **or** their Cognito `sub` via a single
lookup, implemented as a **Prisma Client extension model method**
(`db.user.findByIdOrCognitoSub`) rather than a free-standing helper function:

```ts
async findByIdOrCognitoSub(idOrSub: string) {
  return findFirst({ where: { OR: [{ id: idOrSub }, { cognitoSub: idOrSub }] } });
}
```

- Lives in `shared/db/prisma-extensions.ts`, composing with the existing cross-cutting
  extension so soft-delete exclusion and read-replica routing still apply automatically.
- `getMe`, gRPC `getUserById`, and `updateProfile` all call it. Since Prisma's `update`
  requires a unique `where` (no `OR`), `updateProfile` resolves the target row first via
  this method, then updates by its resolved `id`; on no match it returns `null` so the
  route answers **404** instead of throwing.
- The `usr_` id prefix makes a cross-column collision between the two `OR` arms
  effectively impossible (a Cognito `sub` is a UUID, never `usr_…`).
- No proto field rename, no method rename — the gRPC contract and `getMe`/`getUserById`
  names are unchanged; this method is purely an internal resolution detail.

## Consequences

- Reads/updates now accept either identifier. Once Gap 1 (header injection) lands, `/me`
  resolves without any further query change.
- `updateProfile`'s return type becomes `User | null`, and PATCH `/v1/users/me` gained a
  404 branch mirroring GET `/me`.
- This method (not the free-standing helper explored earlier in the same design
  iteration) is the shape to extend if a future lookup needs the same dual resolution.

## Related

- [[users-service-design]]
- [[ADR-0010-cognito-auth]]
- [[2026-07-11-authenticated-identity-resolution-design]]
- [[2026-07-11-byidorcognitosub]]
