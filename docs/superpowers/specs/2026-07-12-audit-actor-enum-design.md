---
title: AuditActor enum for createdBy/updatedBy
type: spec
area: users
status: draft
created: 2026-07-12
updated: 2026-07-12
tags:
  - type/spec
  - area/users
  - status/draft
related:
  - "[[audit-fields]]"
  - "[[users-service-design]]"
---

# AuditActor enum for createdBy/updatedBy

## Goal

Make `createdBy`/`updatedBy` carry a semantic **action+source** value instead of
a bare id, for the self-service (non-admin) endpoints. The Users service already
uses semantic actor strings in two places (`"e2e-cleanup"`, `"cognito-webhook"`);
this formalizes them into a typed `AuditActor` enum and extends the pattern to
`register` and `updateProfile`.

Decisions (made): replace the actor value (not add columns); a typed TS enum with
`users_api:<action>` values; all under the `users_api` source.

Verified: nothing reads `createdBy` expecting the `usr_` id — it is only stamped,
never queried by value. Test fixtures use `createdBy: "usr_1"` but those are
hand-built rows, not assertions about the stamping. Only the register test's
"self-actor semantics" assertion must change.

## Design

### 1. `AuditActor` enum (`shared/audit/audit-actor.ts`, new)

```ts
// Semantic actor stamped into createdBy/updatedBy (and deletedBy) by the audit
// query extension. Value format: `<source>:<action>`. All current write paths
// originate from the Users API (self-service, not an admin console), so the
// source is `users_api`; the action distinguishes what produced the row.
export enum AuditActor {
  Register = "users_api:register",
  UpdateProfile = "users_api:update_profile",
  IdentityCapture = "users_api:identity_capture",
  E2eCleanup = "users_api:e2e_cleanup",
}
```

### 2. Call sites pass the enum

- **`register.ts`**: `runAsActor(AuditActor.Register, ...)` instead of the `usr_`
  id. The `id` is still generated (row id + `custom:app_user_id`); it just stops
  being the audit actor. Update the comment (no longer "self-actor").
- **`update-profile.ts`**: wrap the `update` call in
  `runAsActor(AuditActor.UpdateProfile, () => this.db.user.update(...))` so
  `updatedBy` is `users_api:update_profile` rather than the per-request
  `currentActor` (the sub) inherited from the `onRequest` hook. Import
  `runAsActor` + `AuditActor`.
- **`capture-cognito-identity.ts`**: `runAsActor("cognito-webhook", ...)` →
  `runAsActor(AuditActor.IdentityCapture, ...)`.
- **`e2e-cleanup.ts`**: `runAsActor("e2e-cleanup", ...)` →
  `runAsActor(AuditActor.E2eCleanup, ...)`.

### 3. The `onRequest` hook stays as-is

`routes.ts`'s `onRequest` hook still populates `currentActor`/the ALS actor from
`x-user-id` — that value is still needed to RESOLVE identity in `getMe`
(`currentActor` → the user). We do NOT change the hook. Self-service commands
that write override the audit actor LOCALLY via `runAsActor(AuditActor.*, ...)`
(the pattern `register` already uses), so the sub is never what lands in
`updatedBy` for those writes.

> Note: `getMe` is read-only (no audit stamping), so the hook's actor value is
> irrelevant to auditing there. Only write paths (register, updateProfile,
> webhook, e2e-cleanup) stamp, and each now wraps its write in the enum actor.

## Testing

- `AuditActor` values are the expected `users_api:*` strings.
- `register`: the created row is written under `runAsActor(AuditActor.Register)`
  — update the existing "self-actor semantics" test to assert the actor is
  `AuditActor.Register` (not the generated id). The id is still generated + passed
  as the row id and to `signUp` (that assertion stays).
- `updateProfile`: the `update` runs under `runAsActor(AuditActor.UpdateProfile)`
  (assert via a spy that `getActor()` inside the update sees the enum value, or
  that the stamped `updatedBy` equals it — mirror how prisma-extensions.test
  checks the ALS actor).
- `capture-cognito-identity` / `e2e-cleanup`: actor is the enum value.
- `prisma-extensions.test` is UNCHANGED — the stamping mechanism (reads the ALS
  actor) is untouched; only the values passed in change.
- Full suite + build + lint green.

## Non-goals (YAGNI)

- No schema migration — `createdBy`/`updatedBy`/`deletedBy` stay `String?`; only
  the values change.
- No new columns (we replace the value, not split into source+action columns).
- No change to the audit extension or the ALS mechanism.
- No `ADMIN_CONSOLE`/`SYSTEM` sources yet — add enum members when those callers
  exist.

## Consequences

- `createdBy`/`updatedBy` become greppable, self-describing audit values
  (`users_api:register`, `users_api:update_profile`, …) instead of opaque ids.
  The trade-off (accepted): the specific acting user's id is no longer in these
  columns for self-service writes — the app-level identity lives on the row
  itself (`id`, `cognitoSub`) and, for updates, is known from the request.
- Formalizes the two existing ad-hoc actor strings under one typed enum.
- `audit-fields.md` (vault) needs updating: the actor is now a semantic enum, and
  the "self-registration → row is its own actor" special case is replaced by
  `AuditActor.Register`. Route via obsidian-vault.

## Related

- [[audit-fields]]
- [[users-service-design]]
