---
title: Resolve users by id or cognitoSub (byIdOrCognitoSub)
type: spec
area: users
status: draft
created: 2026-07-11
updated: 2026-07-11
tags:
  - type/spec
  - area/users
  - status/draft
related:
  - "[[ADR-0010-cognito-auth]]"
  - "[[users-service-design]]"
---

# Resolve users by id or cognitoSub (byIdOrCognitoSub)

## Problem

An authenticated `GET /v1/users/me` returns **404 `not_found`** even with a valid
token, because the identifier the caller is keyed by (the Cognito `sub`) does not
match how the service looks users up.

Two independent gaps were isolated (verified live):

- **Gap 1 — the header never arrives.** Nothing injects `x-user-id` from the JWT
  (not the API Gateway, not nginx). The API Gateway in Floci accepts but does not
  execute header injection — proven three ways (path forwarding, parameter
  mapping, and a Lambda-authorizer `context` mapping all ignored). A control test
  (injecting `x-user-id` directly at nginx → 200) confirmed the service works;
  only the gateway→backend header propagation is missing.
- **Gap 2 — the lookup is by `id` only.** `getMe`/`getUserById`/`updateProfile`
  query `where: { id }`, but the JWT carries the Cognito `sub`, which lives in the
  `cognitoSub` column, not `id`. So even a delivered `sub` yields 404.

**This spec addresses Gap 2 only.** Gap 1 (how the header gets populated —
likely nginx+njs, already POC'd) is deferred to a separate change. Scope here is
pure service code; no nginx/gateway/infra changes.

## Verified behavior (live control test)

Same user, injecting `x-user-id` directly at nginx:

| `x-user-id` value | current query | result |
|---|---|---|
| `usr_v5SXQiTGqtCyOkExZzhQ5` (the usr_ id) | `WHERE id = …` | **200** |
| `24da8dfb-…` (the Cognito sub) | `WHERE id = …` | **404 not_found** |

With the dual-resolution lookup, case 2 also resolves (the sub matches `cognitoSub`).

The `User.cognitoSub` column is `@unique` and already populated by `register`
(`cognitoSub: signUp.sub`), so the link exists — the read paths just don't use it.

## Design

The dual lookup is a **Prisma Client extension model method**
(`db.user.findByIdOrCognitoSub`) — a custom operation on the `user` model —
rather than a free-standing helper. This encapsulates the resolution in the
model, composes with the existing cross-cutting extension (soft-delete injects
`deletedAt: null`; read replicas route the `findFirst`), and reads naturally at
the call sites.

> **Layering:** the extension lives in `shared/db/prisma-extensions.ts`, which
> must NOT import from `features/` (the repo keeps that boundary — only the DI
> container crosses it). So the method returns the **raw Prisma row** (or null),
> exactly like the existing cross-cutting extension operates on rows; the
> feature-layer callers (`getMe`/`getUserById`/`updateProfile`) apply `toDomain`
> as they do today.

### 1. Model method in `crossCuttingExtension` (`shared/db/prisma-extensions.ts`)

Add a `model` component to the existing `client.$extends({...})` in
`crossCuttingExtension` (alongside the current `query` and `result` components):

```ts
model: {
  user: {
    // Resolve a user by their prefixed usr_ id OR their Cognito sub. The
    // authenticated path may carry either identifier; the usr_ prefix makes a
    // cross-column collision effectively impossible. Returns the raw row (or
    // null); callers map to the domain via toDomain. Uses findFirst so the
    // cross-cutting soft-delete/read-replica behavior still applies.
    async findByIdOrCognitoSub(idOrSub: string) {
      const ctx = Prisma.getExtensionContext(this);
      return (ctx as any).findFirst({
        where: { OR: [{ id: idOrSub }, { cognitoSub: idOrSub }] },
      });
    },
  },
},
```

`Prisma.getExtensionContext(this)` yields the current model client (`user`), so
`findFirst` runs through the full extended chain (soft-delete exclusion + read
replica), not a bare unextended client.

### 2. `getMe` (`queries/get-me.ts`) — call the model method

```ts
async getMe(userId: string): Promise<User | null> {
  const row = await this.db.user.findByIdOrCognitoSub(userId);
  return row ? toDomain(row as any) : null;
}
```

### 3. `getUserById` (gRPC-facing, `queries/get-me.ts`) — call the model method

```ts
async getUserById(id: string): Promise<User | null> {
  const row = await this.db.user.findByIdOrCognitoSub(id);
  return row ? toDomain(row as any) : null;
}
```

The gRPC proto field stays named `id` (no breaking contract change); it now
accepts a `usr_` id OR a Cognito sub. The gRPC handler
(`grpc/get-user-by-id.ts`) is unchanged — it already returns `{ user: User | null }`.

> The old free-standing `byIdOrCognitoSub` helper (from the earlier iteration)
> is REMOVED from `get-me.ts` — its logic now lives in the model method.

### 4. `updateProfile` — resolve first, then update; 404 on no match

Prisma `update` requires a UNIQUE `where` and does NOT accept `OR`. So resolve
the target via the model method first, then update by its id. On no match,
return `null` so the route answers **404** (consistent with `getMe`), not a 500.

`commands/update-profile.ts`:
```ts
async execute(userId: string, input: UpdateProfileInput): Promise<User | null> {
  const target = await this.db.user.findByIdOrCognitoSub(userId);
  if (!target) return null;
  const row = await this.db.user.update({
    where: { id: target.id },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.address !== undefined ? { address: input.address as any } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
    },
  });
  return toDomain(row as any);
}
```
Return type is `Promise<User | null>`. (The intermediate `select: { id: true }`
is no longer needed — the method returns the row, and we read `target.id`.)

<!-- OLD helper-based updateProfile below is superseded by the model-method form above -->
<details><summary>superseded helper form</summary>

```ts
import { byIdOrCognitoSub } from "../queries/get-me.ts";

async execute(userId: string, input: UpdateProfileInput): Promise<User | null> {
  const target = await this.db.user.findFirst({
    where: byIdOrCognitoSub(userId),
    select: { id: true },
  });
  if (!target) return null;
  const row = await this.db.user.update({
    where: { id: target.id },
    data: {
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.address !== undefined ? { address: input.address as any } : {}),
      ...(input.phoneNumber !== undefined ? { phoneNumber: input.phoneNumber } : {}),
    },
  });
  return toDomain(row as any);
}
```
Return type changes `Promise<User>` → `Promise<User | null>`.

</details>

### 5. Route handler — 404 on null update

`http/routes.ts` PATCH `/v1/users/me` currently does
`reply.send(serializeUser(updated))` assuming non-null. Handle null:
```ts
const updated = await updateProfileCommand.execute(currentActor as string, req.body);
return updated
  ? reply.send(serializeUser(updated))
  : reply.code(404).send({ error: "not_found" });
```
Add `404: ErrorSchema` to the PATCH route's response schema (GET `/me` already
has it), so the generated OpenAPI documents the 404 and the serializer allows it.

## Non-goals (YAGNI)

- **Gap 1 is out of scope**: no nginx/njs, no gateway, no Lambda authorizer, no
  Pre-Token trigger, no custom attributes. (All POC'd; deferred.)
- No proto field rename (`id` stays).
- No method rename (`getMe`/`getUserById` stay; the model method carries the intent).
- No backfill needed — `register` already sets `cognitoSub`.

## Testing

Unit (Vitest, mocked db):
- **Model method** (`prisma-extensions.test.ts`): `findByIdOrCognitoSub("x")`
  calls the model's `findFirst` with `where: { OR: [{ id: "x" }, { cognitoSub:
  "x" }] }` and returns its row. (Test against a mock model client, consistent
  with how `buildCrossCuttingQueries` is already unit-tested.)
- `getMe`/`getUserById` call `db.user.findByIdOrCognitoSub(arg)` and map the row
  via `toDomain`; return null when the method returns null. (Mock
  `db.user.findByIdOrCognitoSub`.)
- `updateProfile` resolves via `findByIdOrCognitoSub`, updates by the resolved
  id, and returns `null` (no `update` call) when the method returns null.
- Route: PATCH `/v1/users/me` returns 404 when the command returns null; 200 with
  the serialized user otherwise. Existing GET `/me` tests still pass.
- The old `byIdOrCognitoSub` helper test is removed (helper is gone).

These are pure unit tests (no DB, no rebuild) — the change is service code only.
An E2E through the gateway is NOT required for this spec (Gap 1 still blocks the
header end-to-end); the behavior is proven by the direct-inject control test plus
unit coverage.

## Consequences

- Reads/updates now accept either identifier, so once Gap 1 lands (header carries
  the sub), `/me` will resolve without any further query change.
- `updateProfile` gains a `null` return + a 404 route branch — a small, contained
  behavior addition aligned with `getMe`.
- The `usr_` prefix on ids guarantees no ambiguity between the two OR arms in
  practice (a sub is a UUID, never `usr_…`).

## Related

- [[ADR-0010-cognito-auth]]
- [[users-service-design]]
