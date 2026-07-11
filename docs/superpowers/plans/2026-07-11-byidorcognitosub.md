# Resolve users by id or cognitoSub — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `getMe`, gRPC `getUserById`, and `updateProfile` resolve a user by their `usr_` id OR their Cognito `sub` (via a shared `byIdOrCognitoSub` helper), and make PATCH `/v1/users/me` return 404 when no user matches.

**Architecture:** A single exported helper `byIdOrCognitoSub(idOrSub)` returns a Prisma `{ OR: [{id},{cognitoSub}] }` where-clause. Read methods use it directly in `findFirst`; `updateProfile` resolves the id first (Prisma `update` needs a unique where), then updates, returning `null` (→ 404) on no match.

**Tech Stack:** Node 24, Fastify, Prisma, Zod (`zod/v4`), Vitest. Service code only — no infra, no DB, no rebuild.

## Global Constraints

- **Node:** `nvm use` before any node/pnpm command (repo pins 24.18.0). Commands run from `services/users/`.
- **Scope: Gap 2 only.** No nginx/gateway/infra/Cognito changes. This does NOT make an end-to-end authenticated request return 200 (Gap 1 — header injection — is a separate deferred change); it makes the lookups accept either identifier, proven by unit tests + the existing direct-inject control.
- **Zod imports** stay `from "zod/v4"` (repo convention).
- **No rename** of `getMe`/`getUserById` methods or the gRPC proto `id` field. The `byIdOrCognitoSub` helper is the symbol that names the behavior.
- **`updateProfile`** return type becomes `Promise<User | null>`; the route maps null → 404 (consistent with `getMe`).
- **Git:** `users-impl` writes only source, never git/Linear. The main session commits.
- **Language:** code/comments English; converse in Spanish.

---

### Task 1: Add `byIdOrCognitoSub` helper + use it in `getMe` and `getUserById`

**Files:**
- Modify: `services/users/src/features/users/queries/get-me.ts`
- Modify: `services/users/tests/features/users/queries/get-me.test.ts`

**Interfaces:**
- Produces: `export const byIdOrCognitoSub = (idOrSub: string) => ({ OR: [{ id: idOrSub }, { cognitoSub: idOrSub }] })` — imported by Task 2's `update-profile.ts`.

- [ ] **Step 1: Update the existing tests to expect the OR clause (they currently assert `where: { id }`)**

Replace the two assertions in `tests/features/users/queries/get-me.test.ts` and add match-by-cognitoSub coverage:
```ts
import { describe, it, expect, vi } from "vitest";
import { UserQueryService, byIdOrCognitoSub } from "#features/users/queries/get-me";

describe("byIdOrCognitoSub", () => {
  it("builds an OR over id and cognitoSub", () => {
    expect(byIdOrCognitoSub("x")).toEqual({ OR: [{ id: "x" }, { cognitoSub: "x" }] });
  });
});

describe("UserQueryService", () => {
  describe("getMe", () => {
    it("queries by id OR cognitoSub", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      await new UserQueryService({ db }).getMe("usr_1");
      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "usr_1" }, { cognitoSub: "usr_1" }] } });
    });
  });

  describe("getUserById", () => {
    it("queries by id OR cognitoSub", async () => {
      const findFirst = vi.fn(async () => null);
      const db = { user: { findFirst } } as any;
      await new UserQueryService({ db }).getUserById("sub-uuid");
      expect(findFirst).toHaveBeenCalledWith({ where: { OR: [{ id: "sub-uuid" }, { cognitoSub: "sub-uuid" }] } });
    });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nvm use && pnpm test -- get-me.test`
Expected: FAIL — `byIdOrCognitoSub` is not exported; the getMe/getUserById assertions don't match (`{ id }` vs the OR clause).

- [ ] **Step 3: Add the helper and use it**

In `services/users/src/features/users/queries/get-me.ts`, add the helper after the imports (before the class):
```ts
// Resolve a user by their prefixed usr_ id OR their Cognito sub. The
// authenticated path may carry either identifier; the usr_ prefix makes a
// cross-column collision effectively impossible.
export const byIdOrCognitoSub = (idOrSub: string) => ({
  OR: [{ id: idOrSub }, { cognitoSub: idOrSub }],
});
```
Change `getMe`'s query to:
```ts
const row = await this.db.user.findFirst({ where: byIdOrCognitoSub(userId) });
```
Change `getUserById`'s query to:
```ts
const row = await this.db.user.findFirst({ where: byIdOrCognitoSub(id) });
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run: `nvm use && pnpm test -- get-me.test`
Expected: PASS (helper test + getMe + getUserById).

- [ ] **Step 5: Commit** *(main session)*

---

### Task 2: `updateProfile` resolves by id∨cognitoSub, returns null on no match

**Files:**
- Modify: `services/users/src/features/users/commands/update-profile.ts`
- Create: `services/users/tests/features/users/commands/update-profile.test.ts`

**Interfaces:**
- Consumes: `byIdOrCognitoSub` from `../queries/get-me.ts` (Task 1).
- Produces: `UpdateProfileCommand.execute(userId, input): Promise<User | null>` (was `Promise<User>`).

- [ ] **Step 1: Write the failing test**

Create `services/users/tests/features/users/commands/update-profile.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { UpdateProfileCommand } from "#features/users/commands/update-profile";

function makeDb(target: { id: string } | null) {
  const findFirst = vi.fn(async () => target);
  const update = vi.fn(async () => ({
    id: "usr_1", email: "a@b.co", fullName: "New", address: null, phoneNumber: null,
    tags: [], createdBy: null, createdAt: new Date(), updatedBy: null, updatedAt: new Date(),
    deletedBy: null, deletedAt: null,
  }));
  return { db: { user: { findFirst, update } } as any, findFirst, update };
}

describe("UpdateProfileCommand", () => {
  it("resolves by id OR cognitoSub, then updates by the resolved id", async () => {
    const { db, findFirst, update } = makeDb({ id: "usr_1" });
    const res = await new UpdateProfileCommand({ db }).execute("sub-uuid", { fullName: "New" });
    expect(findFirst).toHaveBeenCalledWith({
      where: { OR: [{ id: "sub-uuid" }, { cognitoSub: "sub-uuid" }] },
      select: { id: true },
    });
    expect(update).toHaveBeenCalledWith({ where: { id: "usr_1" }, data: { fullName: "New" } });
    expect(res?.id).toBe("usr_1");
  });

  it("returns null and does not update when no user matches", async () => {
    const { db, update } = makeDb(null);
    const res = await new UpdateProfileCommand({ db }).execute("nope", { fullName: "X" });
    expect(res).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `nvm use && pnpm test -- update-profile.test`
Expected: FAIL — current `execute` calls `update({ where: { id: userId } })` directly (no `findFirst`), so the first assertion fails and the null case throws/mis-updates.

- [ ] **Step 3: Implement resolve-first + null-on-no-match**

Rewrite `services/users/src/features/users/commands/update-profile.ts`'s `execute` (keep the class/constructor and the `UpdateProfileInput` interface):
```ts
import { byIdOrCognitoSub } from "../queries/get-me.ts";
// ...
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
Update the method's return type to `Promise<User | null>`. Ensure `toDomain` and `User` are imported (they are used today).

- [ ] **Step 4: Run to confirm pass**

Run: `nvm use && pnpm test -- update-profile.test`
Expected: PASS (both cases).

- [ ] **Step 5: Commit** *(main session)*

---

### Task 3: PATCH `/v1/users/me` returns 404 on null; document it

**Files:**
- Modify: `services/users/src/features/users/http/routes.ts`
- Modify: `services/users/tests/features/users/http/routes.test.ts`

**Interfaces:**
- Consumes: `updateProfileCommand.execute` now returns `User | null` (Task 2).

- [ ] **Step 1: Add a failing test for the 404 branch**

Append to `tests/features/users/http/routes.test.ts` a test that when `updateProfileCommand.execute` resolves to `null`, PATCH `/v1/users/me` returns 404. Use the existing `testContainer` pattern; register an `updateProfileCommand` whose `execute` returns `null`:
```ts
it("PATCH /v1/users/me returns 404 when the user is not found", async () => {
  const container = testContainer(false);
  container.register({ updateProfileCommand: asValue({ execute: vi.fn(async () => null) } as any) });
  const app = buildApp(container);
  const res = await app.inject({
    method: "PATCH", url: "/v1/users/me",
    headers: { "x-user-id": "nope" },
    payload: { fullName: "X" },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not_found" });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `nvm use && pnpm test -- routes.test`
Expected: FAIL — the handler currently does `reply.send(serializeUser(updated))` with `updated === null`, so it 500s or serializes null, not 404.

- [ ] **Step 3: Handle null in the PATCH handler + schema**

In `services/users/src/features/users/http/routes.ts`, change the PATCH `/v1/users/me` handler body to:
```ts
const updated = await updateProfileCommand.execute(currentActor as string, req.body);
return updated
  ? reply.send(serializeUser(updated))
  : reply.code(404).send({ error: "not_found" });
```
Add `404: ErrorSchema` to that route's `schema.response` (it currently only has `200: UserSchema`), so the serializer permits the 404 body and the generated spec documents it. (`ErrorSchema` is already imported.)

- [ ] **Step 4: Run the full suite**

Run: `nvm use && pnpm test`
Expected: ALL pass — the new 404 test, plus every pre-existing test (the GET `/me` 200/404, register, webhook 401/422, etc.) stays green.

- [ ] **Step 5: Typecheck + lint**

Run: `nvm use && pnpm build && pnpm lint`
Expected: both PASS (the `User | null` return type flows through cleanly).

- [ ] **Step 6: Regenerate the OpenAPI spec (PATCH /me now documents 404)**

Run: `nvm use && pnpm generate:openapi`
Expected: writes `services/users/openapi.yaml`; the PATCH `/v1/users/me` path now includes a `404` response. This keeps the committed spec in sync with the routes.

- [ ] **Step 7: Commit** *(main session)*

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Lint, typecheck, full test, deterministic openapi regen**

Run (from `services/users/`):
```bash
nvm use && pnpm lint && pnpm build && pnpm test && pnpm generate:openapi && git diff --stat services/users/openapi.yaml
```
Expected: lint PASS, build PASS, all tests PASS, generator runs, and after committing Task 3's openapi.yaml the regen diff is empty (deterministic). The PATCH `/v1/users/me` 404 is present in the spec.

---

## Self-Review

**Spec coverage:**
- `byIdOrCognitoSub` helper in `get-me.ts` → Task 1. ✓
- `getMe` + gRPC `getUserById` use it → Task 1. ✓
- `updateProfile` resolves-first, returns null → Task 2. ✓
- PATCH `/me` 404 on null + schema/doc → Task 3. ✓
- Existing `where:{id}` tests updated (would break otherwise) → Task 1 Step 1. ✓
- No proto/method rename, no infra → Global Constraints. ✓
- OpenAPI stays in sync → Task 3 Step 6 + Task 4. ✓

**Placeholder scan:** No TBD/TODO; every step has full code.

**Type consistency:** `byIdOrCognitoSub` signature identical across Tasks 1–2; `updateProfile` return `User | null` matches the handler's null check (Task 3) and the test expectations (Task 2). `ErrorSchema`/`serializeUser` already exist in routes.ts.

## Related

- [[2026-07-11-authenticated-identity-resolution-design]]
- [[ADR-0010-cognito-auth]]
