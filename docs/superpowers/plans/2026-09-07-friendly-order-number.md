---
title: "Friendly Order Number — Options and Plan"
type: plan
area: orders
status: active
created: 2026-09-07
updated: 2026-09-07
tags:
  - type/plan
  - area/orders
  - status/active
propagates-to:
  - "[[orders-service-design]]"
related:
  - "[[nano-id]]"
  - "[[orders-service-design]]"
  - "[[db-naming]]"
  - "[[logging-context]]"
  - "[[money-representation]]"
---

# Friendly Order Number — Options and Plan

## The ask

`ord_RbVmVSLmbHj6DWQ6N4l0d7C8` is not something a person can read, say on the phone,
or copy off a screen without mistakes. Evaluate what to show a customer instead.

## A correction to the framing

The request reads as "change the order id". It should not be, and the distinction is the
whole design:

- The **id** is an internal key. It is a primary key in MySQL, a foreign key from Tracking,
  a field in SQS event envelopes, and a value in log lines across four services.
- The **order number** is a customer-facing label. It appears on a receipt, in an email
  subject, and in a support conversation.

These have different requirements and should be **different fields**. Every option below
that changes the id in place is rejected for the same reason, stated once here: the id
format is a documented cross-service contract ([[nano-id]]), replicated in three languages,
and changing it means changing all three services and migrating every stored row.

## Current state, verified

**The id is minted in three services from the same constants.** `NanoIdConfig` in
`services/orders/src/Orders.Infrastructure/Id/NanoId.cs`, `ALPHABET`/`LENGTH`/`PREFIX_LENGTH`
in `services/users/src/shared/id/nano-id.ts`, and `services/tracking/src/shared/db/nano_id.py`.
The source comment names them a CROSS-SERVICE CONTRACT explicitly: a service that disagrees
about the alphabet or length produces ids the others reject.

**Every id column is `varchar(28)`** — exactly `PrefixLength` (4) + `Length` (24), with no
spare width. The comment in `NanoId.cs` warns that getting this wrong "truncates silently in
MySQL rather than erroring".

**Where a customer sees the raw id today:**

| Surface | File |
|---|---|
| Order detail page — as the `<h1>` page title | `apps/web/src/app/features/orders/order-detail.html:66` |
| Order card in the list | `apps/web/src/app/shared/ui/order-card.html:7` |
| Six email templates | `functions/events-pipeline/src/email/catalog.ts` |

The detail page is the worst case: a 28-character opaque string is the largest text on the
page, where a human expects the thing they can quote to support.

## What "friendly" has to mean here

Four requirements, in the order they constrain the design:

1. **Sayable out loud.** A support call means reading it aloud. This kills mixed case
   immediately — "capital R, lowercase b" is not a phone conversation.
2. **Transcribable without ambiguity.** `0/O`, `1/l/I`, `5/S`, `8/B` are the classic
   confusion pairs when a human copies from a screen or a printed receipt.
3. **Unique, provably.** A duplicate order number is a support incident, not a cosmetic bug.
4. **Short enough to hold in working memory** — roughly 8-12 characters including separators.

## Options

### Option A — Sequential per year: `ORD-2026-000123`

A counter, reset annually, zero-padded, stored in its own column.

- **Uniqueness:** guaranteed by a unique index. Zero collision risk by construction.
- **Readable:** yes, and the year gives a human immediate context.
- **The real cost:** it leaks business volume. `ORD-2026-000123` tells any customer — and
  any competitor who places one order — roughly how many orders exist. For this project
  that may be irrelevant; for a real store it is the reason most vendors avoid it.
- **Concurrency:** needs a counter that two simultaneous checkouts cannot both read. In
  MySQL that means `AUTO_INCREMENT` on a dedicated column, or a transactional counter row.
  **Not** a `SELECT MAX(...)+1`, which is the obvious wrong answer here and is exactly the
  shape of the concurrent-cart bug this repo already hit (JE-246).
- **Rollback burns numbers permanently.** MySQL's `AUTO_INCREMENT` reserves its value
  outside the transaction, so a rolled-back order consumes a number that never appears.
  `ORD-2026-000042` may simply never exist while 41 and 43 do. This is worse than
  cosmetic: anyone who assumes the sequence is contiguous reads the gaps as missing data,
  and support ends up hunting for an order that was never created.
- **A per-year (or per-month) reset is not free in MySQL.** `AUTO_INCREMENT` has no concept
  of a calendar boundary. Resetting it needs either a counter table keyed by period —
  which reintroduces the concurrency problem, and `SELECT MAX(...)+1` on that table is
  exactly the shape of the concurrent-cart bug this repo already hit (JE-246) — or a
  scheduled job that runs `ALTER TABLE` on the boundary, which is a recurring job that can
  fail silently.
- **A finer-grained counter leaks MORE than a coarser one, not less.** A global sequence
  reveals a cumulative total; a per-month sequence reveals the *rate* — two orders placed
  two weeks apart disclose that month's volume directly, which is a stronger signal than
  the yearly total.

### Option B — Random with a safe alphabet: `ORD-8KJ4-M2PX`

Crockford base32 (excludes `I`, `L`, `O`, `U` — 23 usable letters plus digits), uppercase
only, grouped in fours.

Collision probability, using the standard birthday approximation
`p ≈ 1 - exp(-n(n-1)/(2N))`, where `n` is the number of orders and `N = 32^chars` is the
size of the Crockford base32 alphabet space:

| Random chars | 10,000 orders | 1,000,000 orders |
|---|---|---|
| 6 | 4.5% | ~100% |
| 8 | 0.0045% | 36.5% |
| 10 | ~0% | 0.044% |

*(These figures were recomputed for this revision — the table previously published here
overstated every cell, e.g. it claimed 29% at 6 chars/10,000 orders and 99.8% at 8
chars/1,000,000, both roughly an order of magnitude too high. Do not re-derive from the
old numbers.)*

**This is the finding that matters.** The intuitive "short random code" does not work: at
8 characters a collision is still a real risk by a million orders (36.5%). Any random
scheme needs a uniqueness check against the database and a retry, at which point the
collision math only decides how often that retry fires. With a unique index plus retry,
8-10 characters is safe even at high lifetime volume.

- **Readable:** yes, and it leaks nothing about volume.
- **Cost:** a retry loop on insert, which must be tested for the concurrent case.

### Option C — Encode the existing id: `ORD-7GK3-MP1V`

Derive the display number from the nano id (hash or truncate, then re-encode).

**Rejected.** Truncating re-introduces collisions with no unique index to catch them, and a
hash is not reversible, so support still cannot go from the number back to the order without
storing the mapping — which is Option B with extra steps and worse properties.

### Option D — Change the id itself

**Rejected**, for the reason stated at the top: three services, three languages, a documented
contract, `varchar(28)` columns everywhere, and every already-stored row would need migrating.
The friendliness problem is a display problem and does not justify this blast radius.

### Option E — Full-date prefix plus a random suffix: `260907-8KJ4M2` — DECISION

This has exactly **two forms**, and an implementer must not mix them up:

- **Displayed / printed / read aloud:** `260907-8KJ4M2` — a single **hyphen** (`-`)
  between the date and the random suffix. Nothing more elaborate than that: not the
  grouped-in-fours style considered for Option B above, one hyphen only.
- **Canonical, stored, and indexed:** `2609078KJ4M2` — 12 characters, no separator of any
  kind.

The hyphen is a **rendering concern only** — it never reaches the database column or the
unique index. Lookup strips any hyphens and uppercases before comparing against the
canonical form, so a customer who types the number with or without the hyphen finds their
order either way.

**Why this shape wins**, and each of these is load-bearing:

- **The date prefix gives support immediate temporal context** — the thing Option A's year
  prefix was actually buying, without a counter attached to it.
- **The random suffix only has to be unique within its day**, not for the lifetime of the
  store, so it can be shorter than a globally-unique random string while holding the same
  collision probability.
- **It has no counter**, which removes all three problems raised against Option A above:
  no rollback gaps, no per-period reset job, and no rate-leak — a suffix drawn uniformly at
  random discloses nothing about volume regardless of how many orders share a day.

**Collision math for the suffix**, using the same birthday approximation, but sized against
a plausible **daily** order count rather than a lifetime total (this is the whole point of
resetting the collision domain every day — a day is a ~30x smaller collision domain than a
month at the same underlying rate, so the suffix can be shorter for the same safety margin):

| Suffix chars | 1,000/mo (~33/day) | 10,000/mo (~333/day) | 100,000/mo (~3,333/day) |
|---|---|---|---|
| 5 | 0.0016% | 0.16% | 15.3% |
| 6 | ~0% | 0.0051% | 0.52% |
| 7 | ~0% | 0.0002% | 0.016% |

**Recommendation: 6 characters.** This is a change from an earlier revision of this note,
which recommended 7 characters for a *monthly* collision domain (`26-09` + 7 chars gave
0.15% at 10,000 orders/month). Moving to a *daily* domain (`260907` + 6 chars) drops that
to 0.0051% — roughly 30x better — while using one fewer character. At a realistic volume
for this project (up to ~10,000 orders/month, ~333/day), 6 chars keeps the retry rate under
0.006%, rare enough that a unique-index-plus-retry is exception-path code, not routine.
5 chars only holds up below a few hundred orders/day before the retry rate climbs past
0.1%; 7 chars buys headroom into multi-thousand-orders/day volume at the cost of a
character read aloud, for no benefit at this project's scale. State the retry rate that
follows from whatever length ships — do not present it as collision-free.

**Timezone must be pinned.** The prefix is derived from the order's creation date in a
**fixed** timezone — UTC, or an explicitly chosen business timezone (still open; pick one,
do not leave it as a placeholder). Deriving it from the server process's local time is
wrong: two orders placed either side of local midnight would land on different dates
depending on which host or region served the request, and the number would stop being
reproducible from the stored `created_at`. Backfill must apply the exact same rule, or
backfilled and freshly-minted numbers disagree on which orders share a day.

**Canonical length is fixed at 12 characters** (6-digit date + 6-character random suffix,
no separator). Worth stating explicitly for the column definition — this note already
documents how the id's `varchar(28)` with no spare width bit this repo before
([[nano-id]]); `order_number` should not repeat that mistake.

## Recommendation

**Option E — `order_number` = full-date (`YYMMDD`) prefix + 6-character random
Crockford-base32 suffix, unique per day, stored without separators as a fixed 12-character
value, displayed as `YYMMDD-XXXXXX`.**

This supersedes the Option B recommendation this note originally carried. Option B's
core finding still holds and is why Option E is built the way it is: a random component
needs a unique index and a retry, sized by the collision math above. Option E changes what
that random component is sized against — a day of orders instead of the store's entire
lifetime — which is what lets it stay short. Why over Option A: it gives the same
temporal context the year prefix was buying, without a counter, and therefore without any
of the three problems listed in Option A's analysis (rollback gaps, reset-job complexity,
rate-leak).

Design points worth fixing before implementation:

- **The id stays exactly as it is.** `order_number` is additive: a new nullable
  `char(12)` column, a single plain unique index on the full column, and a new field on
  the API response. No existing contract moves. This is **not** a MySQL prefix index
  (`INDEX (order_number(6))`) — that indexes only the first 6 characters and would make
  every order on the same day collide, the opposite of what is wanted. A plain unique
  index on the whole 12-character value already gives per-day uniqueness for free, because
  the date prefix is part of the stored value: `2609078KJ4M2` and `2609088KJ4M2` are
  different strings, so the same suffix on two different days never collides. The daily
  collision domain is a property of the *value*, not of the index — the same reason the
  suffix can be 6 characters instead of 7.
- **The prefix must come from the order's own creation date, not "now" at render time.**
  Deriving it at render time means the same order's displayed number changes depending on
  when it is viewed, which breaks the "quote this to support" use case the whole feature
  exists for.
- **The prefix's date must be computed in a fixed timezone** (UTC, or an explicitly chosen
  business timezone — still open, see below), never the server process's local time, and
  backfill must use the identical rule so historical and new numbers agree on day
  boundaries.
- **Uppercase only, Crockford base32** (excludes `I`, `L`, `O`, `U`) for the suffix — this is
  what makes it sayable and transcribable, not a style preference.
- **Store the canonical form with no separator** (`2609078KJ4M2`); render a single hyphen
  between date and suffix for display (`260907-8KJ4M2`). The hyphen never reaches the
  column or the index — it is a rendering-layer concern only.
- **Lookup must normalize case and strip separators before comparing.**
- **Backfill is required for existing orders.** Existing rows have `created_at`, so their
  `YYMMDD` prefix is derivable directly (using the same fixed timezone rule); only the
  random suffix needs to be freshly generated (and checked for uniqueness) per row at
  backfill time.
- **The API DTO returns `orderNumber` as an object with both forms, not a bare string** —
  following the shape this repo already uses for `Money` ([[money-representation]]):

  ```json
  "orderNumber": {
    "raw": "2609078KJ4M2",
    "formatted": "260907-8KJ4M2"
  }
  ```

  - **The server owns the formatting rule.** Consumers render `formatted` verbatim and
    never construct it themselves. This is the same reason `Money.formatted` exists:
    `apps/web/src/app/features/checkout/checkout-payment.ts` carries a CONTRACT comment
    that every rendered figure must be the server's string verbatim, because re-deriving
    it client-side can produce a value that disagrees with what the server actually holds.
    The identical risk applies here — if each consumer inserts its own hyphen, the web
    app, the six email templates, and any future consumer each own a copy of the
    formatting rule, and they will drift: one of them eventually renders
    `26-0907-8KJ4M2` or lowercases it, and a customer reads out a number that does not
    match what support sees.
  - **`raw` is what a consumer sends back** — in a lookup, a support search, or a URL if
    open question #3 resolves that way. `formatted` is never sent back to the server
    without normalizing first (strip the hyphen, uppercase).
  - **Both fields are present whenever the order has a number; the whole `orderNumber`
    object is `null`/absent otherwise** — for an order that predates the backfill, not an
    object with empty-string fields. An object with blank fields is a value that looks
    present but isn't, which is a worse failure mode for a display layer than an absent
    field it can branch on.
  - **The field name `orderNumber` (camelCase, matching this repo's wire casing —
    [[money-representation]] documents the same casing rule for `Money`) must be used
    identically across the Orders API response, the web DTO, and the data passed into the
    six email templates** — the "Current state, verified" table above already lists all
    three surfaces as consumers of the raw id today — a renamed or reshaped field in any
    one of them defeats the point of a single source of truth for the formatting rule.

## Open questions

1. ~~Is leaking order volume actually a concern for this project?~~ **Closed by the
   decision.** Option E has no counter of any kind, so there is no volume or rate to leak
   regardless of the answer.
2. **Which fixed timezone does the date prefix use** — UTC, or a specific business
   timezone? New question, raised by the daily collision domain: the prefix must be
   computed consistently regardless of which host or region serves the request, and
   backfill must match. Still open; either answer works as long as it is pinned and
   applied uniformly.
3. **Does the number belong in the URL** (`/orders/260907-8KJ4M2`) or does the URL keep the
   id? Still open. Relevant fact for whoever decides this: the web app currently routes on
   the raw id — `apps/web/src/app/app.routes.ts:46` defines `orders/:orderId`, and
   `apps/web/src/app/features/orders/order-detail.html:66` renders `entry.order.id` as the
   page `<h1>`. Switching the URL to the order number is therefore a routing change, not
   merely a display change.
4. **Do Tracking and the events pipeline need it**, or is it purely an Orders + web + email
   concern? Still open. The event envelope carries `order_id` today; adding a second
   identifier to it should be a deliberate decision, not a side effect.

## Related

- [[nano-id]] — the id format this deliberately does not change
- [[orders-service-design]] — where the new column and index would live
- [[db-naming]] — column naming for `order_number`
- [[logging-context]] — logs keep using `order_id`; the display number is not a log field
- [[money-representation]] — the `raw`/`formatted` DTO pattern `orderNumber` follows
