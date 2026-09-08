---
title: Friendly Order Number
type: convention
area: orders
status: active
created: 2026-09-08
updated: 2026-09-08
tags:
  - type/convention
  - area/orders
  - status/active
related:
  - "[[money-representation]]"
  - "[[nano-id]]"
  - "[[orders-service-design]]"
  - "[[db-naming]]"
  - "[[events-pipeline-design]]"
  - "[[testing]]"
  - "[[2026-09-07-friendly-order-number]]"
---

# Friendly Order Number

Customer-facing order number shipped in commit `67cb612` (Linear JE-252). The design
options and collision math were worked out in
[[2026-09-07-friendly-order-number|the design plan]]; this note states the rule as it now
**is** in the code — it does not re-argue the alternatives.

## The rule

`order_number` is a customer-facing **label**, separate from `Order.Id`. The `ord_` nano id
([[nano-id]]) remains the identifier: primary key, Tracking's foreign key, the event
envelope's `order_id`, every log line. Never join on the number, never log it, and never let
it replace the id in a contract.

## Format

- **Displayed / read aloud / printed:** `260907-8KJ4M2` — one hyphen between date and suffix.
- **Stored / canonical / indexed:** `2609078KJ4M2` — `char(12)`, no separator.

The value is a six-digit `YYMMDD` UTC date prefix plus six Crockford base32 characters. The
alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — it excludes `I`, `L`, `O`, `U` — and is
uppercase only. That combination is what makes the suffix sayable on a phone call and
transcribable off a screen.

**The separator is a rendering concern only.** It never reaches the column or the index.
Lookup must normalize (strip separators/whitespace, uppercase with `InvariantCulture`)
before comparing.

## Uniqueness

A **plain unique index on the whole column** (`ux_order_order_number`,
`OrderConfiguration.OrderNumberIndexName`), never a MySQL prefix index. A prefix index would
index only the date and make every order placed on the same day collide — the opposite of
what is wanted.

Per-day uniqueness is a property of the **value**, not the index: the date is part of the
stored string, so `2609078KJ4M2` and `2609088KJ4M2` never collide even with an identical
suffix. That is what lets the suffix be six characters instead of seven.

This is **not** collision-free. The index guarantees uniqueness; the six-character suffix
only sets how often the retry fires — roughly 0.005% at ~333 orders/day.

## Collision retry

`CreateOrderService` re-mints on a unique-index rejection, detected by **index name**
(`OrderConfiguration.OrderNumberIndexName`), never by the bare MySQL error number — that
number also fires on the order's other constraints, and re-minting on those would hide a real
bug. Bounded at 3 attempts; the last failure rethrows. An unbounded loop would hold `FOR
UPDATE` on every product in the order and serialize the catalogue's checkout.

## UTC is pinned — and there is a specific trap

The prefix comes from the order's **own** `created_at`, in UTC, never "now" at render time.

`OrderNumber.DatePrefix` treats a `DateTimeKind.Unspecified` instant as **already UTC** and
does **not** convert it. MySQL returns every `created_at` that way, and calling
`ToUniversalTime()` on it would shift the value by the host's offset — moving a 23:30Z order
onto the next day west of UTC. That would make the backfill and the live service disagree
about which orders share a day. This was caught by mutation testing, not by reasoning about
the code.

## The wire shape mirrors Money

Following [[money-representation]]:

```json
"orderNumber": {
  "raw": "2609078KJ4M2",
  "formatted": "260907-8KJ4M2"
}
```

- The whole `orderNumber` object is `null`/omitted when the order has none — never an object
  of empty-string fields, which is a value that looks present but is not.
- The **server owns the display rule**. Every consumer renders `formatted` verbatim. Six
  email templates each inserting their own hyphen is six copies that drift, and a customer
  then reads out a number support cannot find.

## Backward compatibility

`order_number` is `.optional()` on **every** consumer schema in the events pipeline, for the
same reason `request_id` is. A message published before the field existed can still be on the
queue at deploy time; a schema failure there is a `PermanentError`, and the record's email is
lost silently. See `functions/events-pipeline/src/domain/order-number.ts`.

## Tracking mirrors the column, never mints one

`services/tracking-go` mirrors the column (migration `000002_add_order_number`,
`internal/domain/order_number.go`). Tracking never generates a number — Orders owns the
format and the uniqueness guarantee.

The mirror exists because Tracking produces five of the six email templates, and the
events-pipeline Lambda holds no connection to the Orders database, so the envelope must carry
everything a template renders.

Tracking's column deliberately has **no unique constraint of its own**: `uq_tracking_order_id`
already gives one tracking row per order, and re-declaring uniqueness on the number would make
Tracking reject a row for a duplicate it has no authority to adjudicate.

## The backfill

Migration `20260908192043_AddOrderNumber` runs in three **ordered** steps: add the column,
backfill, then create the unique index. Indexing first would abort the migration halfway on
the first duplicate, leaving some orders numbered and some not.

The backfill's SQL repeats the Crockford alphabet as a literal, because a constant cannot
cross the C#/SQL boundary — `OrderNumberTests` pins the two against each other so they cannot
silently drift.

Verified against real MySQL: 10 legacy rows, all canonical, all distinct, each prefix matching
its own `created_at`.

## What did not change

The URL still routes on the raw id (`/orders/:orderId`), and the id remains what logs,
envelopes, and foreign keys carry. Only what the customer **reads** changed: the order-detail
`<h1>`, the order card, the six email bodies, and the tracking email subject line.

## Key files

- `services/orders/src/Orders.Domain/OrderNumber.cs` — format, minting, `DatePrefix` UTC rule
- `services/orders/src/Orders.Application/Orders/OrderNumberDto.cs` — wire shape
- `services/orders/src/Orders.Infrastructure/Persistence/Configurations/OrderConfiguration.cs` — unique index
- `services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs` — collision retry
- `services/orders/src/Orders.Infrastructure/Migrations/20260908192043_AddOrderNumber.cs` — backfill
- `services/tracking-go/internal/domain/order_number.go` — mirror, format-only
- `functions/events-pipeline/src/domain/order-number.ts` — optional consumer schema

## Related

- [[2026-09-07-friendly-order-number]] — the design plan this note propagates
- [[money-representation]] — the `raw`/`formatted` DTO pattern this format follows
- [[nano-id]] — the id this label deliberately does not replace
- [[orders-service-design]] — where the column and index live
- [[db-naming]] — column/index naming conventions
- [[events-pipeline-design]] — optional-field backward-compatibility rule
- [[testing]] — mutation testing that caught the UTC conversion trap
