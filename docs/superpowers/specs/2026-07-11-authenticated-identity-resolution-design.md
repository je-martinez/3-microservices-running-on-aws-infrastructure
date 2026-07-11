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

With `byIdOrCognitoSub`, case 2 would also resolve (the sub matches `cognitoSub`).

The `User.cognitoSub` column is `@unique` and already populated by `register`
(`cognitoSub: signUp.sub`), so the link exists — the read paths just don't use it.

## Design

### 1. Shared helper (in `queries/get-me.ts`, exported)

```ts
// Resolve a user by their prefixed usr_ id OR their Cognito sub. The
// authenticated path may carry either identifier; the usr_ prefix makes a
// cross-column collision effectively impossible.
export const byIdOrCognitoSub = (idOrSub: string) => ({
  OR: [{ id: idOrSub }, { cognitoSub: idOrSub }],
});
```

### 2. `getMe` — use the helper

`queries/get-me.ts`:
```ts
async getMe(userId: string): Promise<User | null> {
  const row = await this.db.user.findFirst({ where: byIdOrCognitoSub(userId) });
  return row ? toDomain(row as any) : null;
}
```

### 3. `getUserById` (gRPC-facing) — use the helper

`queries/get-me.ts`:
```ts
async getUserById(id: string): Promise<User | null> {
  const row = await this.db.user.findFirst({ where: byIdOrCognitoSub(id) });
  return row ? toDomain(row as any) : null;
}
```

The gRPC proto field stays named `id` (no breaking contract change); it now
accepts a `usr_` id OR a Cognito sub. The gRPC handler
(`grpc/get-user-by-id.ts`) is unchanged — it already returns `{ user: User | null }`.

> Naming note (per the "rename the byId things to byIdOrCognitoSub" request): the
> public method names `getMe`/`getUserById` stay (renaming ripples through the DI
> cradle, gRPC wiring, and tests for no behavioral gain). The intent is captured
> by the shared **`byIdOrCognitoSub`** helper both methods now use — that is the
> symbol whose name states the dual-lookup behavior.

### 4. `updateProfile` — resolve first, then update; 404 on no match

Prisma `update` requires a UNIQUE `where` and does NOT accept `OR`. So resolve
the target id via the helper first, then update by that id. On no match, return
`null` so the route answers **404** (consistent with `getMe`), not a 500.

`commands/update-profile.ts`:
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
- No method rename (`getMe`/`getUserById` stay; the helper carries the intent).
- No backfill needed — `register` already sets `cognitoSub`.

## Testing

Unit (Vitest, mocked db):
- `byIdOrCognitoSub("x")` returns `{ OR: [{ id: "x" }, { cognitoSub: "x" }] }`.
- `getMe` returns the user when the arg matches the row's `id` OR its
  `cognitoSub`; null when neither.
- `getUserById` (same).
- `updateProfile` updates when the arg matches by id OR cognitoSub; returns
  `null` when neither (assert no `update` call is made in that case).
- Route: PATCH `/v1/users/me` returns 404 when the command returns null; 200 with
  the serialized user otherwise. Existing GET `/me` tests still pass.

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
