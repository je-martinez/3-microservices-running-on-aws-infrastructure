---
title: Nano ID entity identifiers
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-07-12
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[db-naming]]", "[[audit-fields]]", "[[soft-delete]]", "[[users-service-design]]"]
---

# Nano ID entity identifiers

## Rule

Entity identifiers use a Stripe-style `prefix_nanoid` format: a short per-entity prefix, an underscore, then a Nano ID. For example an order is `ord_wldA4A0WwZAKUm`.

- The prefix is fixed per entity type (e.g. `ord_` for orders, `usr_` for users) so an ID is self-describing.
- This format is the primary key in our relational databases.
- The same scheme is reused for the events pipeline `friendlyId`.

## Rationale

Prefixed Nano IDs are URL-safe, collision-resistant, and human-readable: you can tell at a glance what an ID refers to, which helps when debugging across service boundaries and logs. Reusing the same scheme for the events `friendlyId` keeps identifiers consistent end to end.

## Implementation (Users service, [JE-39](https://linear.app/issue/JE-39))

The Users service implements this rule (along with [[audit-fields]] and [[soft-delete]]) via a **single Prisma client extension**, rather than manual per-command helpers:

- Per-model prefixes live in one map, `MODEL_ID_PREFIXES`, in `services/users/src/shared/id/nano-id.ts` — the single source of truth. It now has **three** entries: `User: "usr_"`, `UsersCognitoData: "ucd_"`, `UsersCognitoEvent: "cge_"` (the latter two added for the Cognito identity tables — see [[users-service-design]]). Extending to a new model means adding an entry there; nothing else needs to change.
- `id` is stamped automatically on `create`/`createMany` by a `$allModels` query extension when the caller doesn't already supply one. Models with no entry in the map are left untouched and log a dev-only warning, since every model in the schema is expected to register a prefix.
- This query extension is composed together with the audit-fields and soft-delete extensions into one `crossCuttingExtension` in `services/users/src/shared/db/prisma-extensions.ts`, applied to the Prisma client in `services/users/src/shared/db/prisma.ts`.

### Exceptions — callers that still generate ids by hand

The claim that "callers no longer generate IDs by hand" is now only **partly** true. Two call
sites deliberately bypass the extension's auto-stamp:

- **`services/users/src/features/users/commands/register.ts`** generates the `usr_` id **before**
  calling Cognito `signUp`, because the id must exist to be passed as `appUserId` and land in
  Cognito's `custom:app_user_id` custom attribute before the corresponding `users` row exists (see
  [[users-service-design]] and [[cognito-pre-token-lambda]]). The id is then reused as the row's
  own `id` on `create`, so the extension sees `data.id` already set and skips stamping — this is
  the extension's normal "don't overwrite a caller-supplied id" behavior, applied intentionally.
- **`services/users/src/features/users/webhooks/capture-cognito-identity.ts`** generates both the
  `UsersCognitoData` and `UsersCognitoEvent` ids by hand (`generateId(MODEL_ID_PREFIXES.UsersCognitoData)`,
  `generateId(MODEL_ID_PREFIXES.UsersCognitoEvent)`) because the write is a **nested** create
  (`usersCognitoData.upsert(...)` with `events: { create: [...] } }`) and the Prisma-generated
  create-input types for that nested object-literal shape require `id` explicitly — the
  `$allModels` query extension's auto-stamp does not reach into nested `create` payloads the same
  way it does a top-level `create`/`createMany` call.

## Related

- [[db-naming]] — how these IDs and other columns are named in the database.
- [[audit-fields]] — stamped by the same Prisma client extension.
- [[soft-delete]] — stamped by the same Prisma client extension.
- [[users-service-design]] — the two exceptions above, in context.
