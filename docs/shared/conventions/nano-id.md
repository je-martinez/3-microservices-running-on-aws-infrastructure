---
title: Nano ID entity identifiers
type: convention
area: shared
status: active
created: 2026-06-26
updated: 2026-08-27
tags: [type/convention, area/shared, status/active, issue/JE-39]
related: ["[[db-naming]]", "[[audit-fields]]", "[[soft-delete]]", "[[users-service-design]]", "[[events-pipeline-design]]", "[[logging-context]]", "[[orders-service-design]]", "[[tracking-service-design]]"]
---

# Nano ID entity identifiers

## Rule

Entity identifiers use a Stripe-style `prefix_nanoid` format: a short per-entity prefix, an underscore, then a Nano ID. For example an order is `ord_7gK3mP1vXz9wLq2bN8rRt4Yc`.

- The prefix is fixed per entity type (e.g. `ord_` for orders, `usr_` for users) so an ID is self-describing.
- This format is the primary key in our relational databases.

### Registered prefixes (Orders)

| Prefix | Entity |
|---|---|
| `prd_` | Product |
| `ord_` | Order |
| `odd_` | OrderDetails |
| `crt_` | Cart |
| `cti_` | CartItem |

`crt_`/`cti_` added 2026-08-25 alongside the Cart aggregate — see
[[2026-08-25-cart-endpoints-design]] and [[orders-service-design]].

## Rationale

Prefixed Nano IDs are URL-safe, collision-resistant, and human-readable: you can tell at a glance what an ID refers to, which helps when debugging across service boundaries and logs.

## Format change (2026-08-15) — custom alphabet, 28 characters stored

> [!info] Implemented and verified live in all three services
> One flow through the live gateway produced `usr_`, `prd_`, `ord_` and `trk_` ids, all 28
> characters, minted by three different services, each matching `^[a-z]{3}_[A-Za-z0-9]{24}$`.
> Test counts after the change: users 362, orders 178, tracking 633.

The id format changed from nanoid's **default** alphabet to a **custom** one, and got longer:

| | Old | New |
|---|---|---|
| Alphabet | nanoid default (64 chars, includes `_` and `-`) | `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789` (62 chars, letters + digits only) |
| Random-portion length | 21 | 24 |
| Prefix length | 4 (`xxx_`) | 4 (`xxx_`) — unchanged |
| Total stored width | 25 | **28** |

**Why a custom alphabet.** An id gets pasted into a shell, a URL, a log grep, and a CSV. A
leading `-` reads as a flag; `_` disappears against an underscored column name. Removing those
two characters removes a class of papercuts with no downside.

**Entropy went UP, not down** — say this explicitly, because the instinct is to assume a smaller
alphabet is weaker. `62^24` is greater than `64^21`. Restricting the alphabet while lengthening
the id means collision risk **decreased**.

**28 is the number every id column must be sized for.** MySQL truncates a too-long value
silently rather than erroring, so a column left at the old `VARCHAR(26)` would have stored
corrupt ids with no error anywhere. Both MySQL services were migrated: orders (19 columns) and
tracking (6 columns), all now `VARCHAR(28)` — verified against the live databases.

### Existing data is not migrated

The old 25-character ids remain valid and readable — they fit within `VARCHAR(28)` and were left
as-is. Only **newly minted** ids use the new format. No data migration is needed or planned for
already-stored ids.

## Structural rule — one configuration class per service

Each service defines its id format in **one** class/module that holds: the alphabet, the length,
the prefix width, the total width, every prefix it mints, a pattern builder derived from those
values, and **one factory method per prefix**.

| Service | File | Class |
|---|---|---|
| users | `services/users/src/shared/id/nano-id.ts` | `NanoIdConfig` (a `const` object typed via a mapped type + `satisfies`) |
| orders | `services/orders/src/Orders.Infrastructure/Id/NanoId.cs` | `NanoIdConfig` |
| tracking | `services/tracking-go/internal/domain/id.go` | package-level constants + one `New*ID` factory function per prefix |

Two rules worth stating as rules:

1. **Call sites never write a raw prefix string.** They call the factory —
   `NanoIdConfig.newUserId()`, `domain.NewTrackingID()` — so a typo is a compile error (or an
   import-time failure) rather than a row with an unrecognisable id.
2. **A prefix without a factory must FAIL, not slip through.** TypeScript enforces this with a
   mapped type (`{ [K in PrefixKey as \`new${K}Id\`]: () => string }` composed with `satisfies`),
   so adding a prefix without its factory does not compile. Go has no equivalent exhaustive
   mapping over package-level constants either, but there is no runtime gap to cover: `mint`
   (the single generation path) is unexported, so a prefix minted without going through its own
   `New*ID` function is a compile error, not a check that has to run and possibly get skipped.

**Every validation regex is derived from the config, never hand-written.** A hand-written pattern
is how a service starts rejecting its own ids after a format change. This bites orders
specifically: `[GeneratedRegex]` requires a compile-time literal, so that class had to stop being
`partial` and compile its pattern into a static field instead, built from the same
alphabet/length constants rather than restated as a literal.

## Cross-service contract

The three values (alphabet, random-portion length, prefix length) are the same in all three
services **by contract**: ids travel in headers, SQS envelopes, and foreign keys, so a service
that disagrees about the alphabet or the length produces ids the others reject. Changing any of
them means changing all three together.

## Testing requirement

Each service pins, per this convention:

- the alphabet is letters+digits only, no duplicates, exactly 62 characters;
- a generated id is `prefix` + 24 alphabet characters, 28 characters total;
- a large sample has no collisions and no character outside the alphabet;
- prefixes are all `xxx_` and unique;
- the derived pattern **accepts** what the generator produces and **rejects** the previous
  21-character format.

## Scope correction — events-pipeline does not use this scheme

> [!warning] The events-pipeline no longer mints a prefixed nano-id
> Earlier versions of this note (and of [[events-pipeline-design]]) said the events pipeline
> reused this scheme for an `evt_`-prefixed `friendlyId`. As implemented (commit `5fd6e0d`),
> that field was **removed**: the pipeline has no `nanoid` dependency and mints no id of its
> own. `event_id` — the producer-generated idempotency key already carried in the SQS
> envelope — is now the event's only identifier. This scheme (`prefix_nanoid`) remains in
> effect for the services below; the events-pipeline is simply not one of its consumers.

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
- [[events-pipeline-design]] — the events-pipeline's scope correction: it does not consume this scheme.
- [[logging-context]] — `request_id` follows this same `prefix_nanoid` convention (`req_` +
  24 alphabet characters, 28 total), including the format change above.
- [[orders-service-design]] — orders' `NanoIdConfig` and the 19 MySQL columns migrated to
  `VARCHAR(28)`.
- [[tracking-service-design]] — tracking's `NanoIdConfig`, its import-time exhaustiveness check,
  and the 6 MySQL columns migrated to `VARCHAR(28)`.
- [[2026-08-25-cart-endpoints-design]] — added the `crt_`/`cti_` prefixes for the Cart aggregate.
