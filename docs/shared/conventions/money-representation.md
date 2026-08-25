---
title: Money Representation on the Wire
type: convention
area: shared
status: active
created: 2026-08-25
updated: 2026-08-25
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[orders-service-design]]"
  - "[[money-as-integer-cents]]"
  - "[[db-naming]]"
  - "[[2026-08-25-cart-endpoints-design]]"
---

# Money Representation on the Wire

## Rule

Every HTTP amount in this repo is a `Money` object, never a bare number:

```json
{ "cents": 3998, "amount": "39.98", "formatted": "$39.98", "currency": "USD" }
```

| Field | Meaning |
|---|---|
| `cents` | The authoritative integer value. Everything else is derived from it. |
| `amount` | A plain decimal string (`InvariantCulture`, `"F2"`) a client can parse without locale surprises. |
| `formatted` | A display string (`en-US`, `"C2"`) with currency symbol and thousands separator, e.g. `"$1,000.00"`. |
| `currency` | The constant `"USD"` — this repo has no multi-currency. |

This is cross-cutting rather than an Orders detail: Orders is currently the **only** service
exposing money over HTTP (Users and Tracking have no monetary amounts; events-pipeline consumes
`ORDER_CREATED` internally, not this shape), but the wire contract belongs here so a future
service exposing money reuses it rather than inventing its own.

## Boundaries — read before touching a `Money` field

- **`Money` is a DTO/HTTP-layer concern ONLY.** Storage stays integer cents in `bigint` columns
  mapped to `long` — see [[money-as-integer-cents]] for the storage-side decision. `Money` must
  never reach a `DbContext`, an entity, or a migration.
- **`Cents` is authoritative; `amount` and `formatted` are derived views.** Construct a `Money`
  only via `Money.FromCents(cents)` — the primary constructor is public (records need this) but
  handing it four independently-chosen values can produce a `Money` whose fields disagree with
  each other. `FromCents` is the only path that guarantees they agree.
- **The `ORDER_CREATED` SQS envelope is unaffected.** It keeps raw integer cents, unchanged. It
  is a contract with events-pipeline, which has its own tests and was deliberately not widened
  for this change.
- **Wire casing is camelCase**, like every other Orders HTTP response — `cents`, `amount`,
  `formatted`, `currency`, not snake_case. The repo's snake_case convention ([[db-naming]])
  applies to database columns and to the SQS envelope, not to HTTP JSON.
- **Currency is a constant.** `"USD"` is hardcoded; there is no multi-currency support and no
  plan to add one (YAGNI — see [[2026-08-25-cart-endpoints-design]]'s Out of scope section).

## Why the culture is pinned explicitly

`amount` is built with `CultureInfo.InvariantCulture`; `formatted` is built against `en-US`
explicitly — **neither reads the ambient/container culture.**

This is not defensive boilerplate; it is pinned by a test
(`FromCents_is_independent_of_the_ambient_culture`, `services/orders/tests/Orders.Tests/Domain/MoneyTests.cs`)
that overrides `CultureInfo.CurrentCulture` to `de-DE` mid-test, because of the specific failure
this type exists to prevent: under a container whose default culture is, say, `de-DE`, an
implementation that reads the ambient culture emits `"39,98"` instead of `"39.98"` for `amount`.
Every client parsing `amount` as a decimal then breaks — **silently**, and only in that one
deployment, with no error raised anywhere in the pipeline. Pinning the culture at construction
time removes the ambient culture as a variable entirely.

## Example — .NET implementation (Orders)

```csharp
public sealed record Money(long Cents, string Amount, string Formatted, string Currency)
{
    public const string Usd = "USD";

    public static Money FromCents(long cents)
    {
        var dollars = cents / 100m;
        return new Money(
            cents,
            dollars.ToString("F2", CultureInfo.InvariantCulture),
            dollars.ToString("C2", CultureInfo.GetCultureInfo("en-US")),
            Usd);
    }
}
```

Full context: `docs/superpowers/specs/2026-08-25-cart-endpoints-design.md`, Part A.

## Related

- [[orders-service-design]] — where `Money` replaced every `*_cents` DTO field
  (`OrderDto`, `OrderLineDto`, `ProductDto`, `CartDto`, `CartLineDto`).
- [[money-as-integer-cents]] — the storage-side ADR this convention deliberately does not
  change: `bigint` cents columns stay as they are.
- [[db-naming]] — snake_case applies to DB columns and the SQS envelope, not to this HTTP shape.
- [[2026-08-25-cart-endpoints-design]] — the spec that introduced `Money`.
