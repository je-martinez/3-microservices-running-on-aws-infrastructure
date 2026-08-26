---
title: "InnoDB rejects a CASCADE foreign key on a column a stored generated column depends on"
type: lesson
area: orders
status: active
created: 2026-08-25
updated: 2026-08-26
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/medium
related:
  - "[[orders-service-design]]"
  - "[[2026-08-25-cart-endpoints-design]]"
  - "[[soft-delete]]"
  - "[[db-naming]]"
---

# InnoDB rejects a CASCADE foreign key on a column a stored generated column depends on

## Finding

Adding the Cart aggregate's `cart_item` table failed EF migration application with MySQL errno
1215, `Cannot add foreign key constraint`, on the default (`CASCADE`) foreign key EF Core
generates for `cart_item.cart_id → cart.id`.

The generated column at fault is `active_cart_id` — the stored, computed column backing the
one-active-cart-line-per-product unique index (see [[orders-service-design#Cart]] and
[[2026-08-25-cart-endpoints-design]]):

```sql
active_cart_id VARCHAR(28) AS (CASE WHEN deleted_at IS NULL THEN cart_id ELSE NULL END) STORED
```

InnoDB refuses a `CASCADE` (or `SET NULL`) foreign key on `cart_id` because `active_cart_id` is
a **stored** generated column that reads `cart_id`: a cascading delete/nullify on the parent
would need to recompute `active_cart_id` as a side effect of a constraint action, which InnoDB
does not support. The same restriction would apply to `Cart.active_user_id` if `Cart` itself
had a cascading parent — it does not, so only `cart_item` hit this in practice.

## Root cause, precisely

Not a bug in the generated-column expression itself — the CASE expression is correct and works
fine once the FK is declared correctly. The failure is specifically about the **interaction**
between a stored generated column and a cascading FK action on the column it reads.

## Fix

`.OnDelete(DeleteBehavior.Restrict)` instead of the EF default (`Cascade`) on the
`Cart`→`CartItem` relationship, in `CartConfiguration.Configure`:

```csharp
b.HasMany(c => c.Items).WithOne().HasForeignKey(i => i.CartId)
    .OnDelete(DeleteBehavior.Restrict);
```

`Restrict` is inert in this repo regardless: the schema is soft-delete only
([[soft-delete]]) and the `orders_app` database user has no `DELETE` grant, so a cascading
delete could never actually fire here. Choosing `Restrict` costs nothing and satisfies InnoDB.

## Isolation method

Reproduced with plain DDL outside EF (`ALTER TABLE ... ADD CONSTRAINT ... ON DELETE CASCADE`)
against the same generated-column definition, confirming the failure was MySQL/InnoDB's own
constraint, not an EF Core code-generation defect — worth doing before assuming the ORM is at
fault.

## How to apply

- **Any future stored generated column that reads a foreign-keyed column must pair with
  `DeleteBehavior.Restrict` (or `NoAction`) on that FK**, not EF's default `Cascade`. This will
  recur verbatim the next time this repo (or another with the same active-row-via-generated-
  column pattern) adds a child table whose active/soft-delete state is tracked through a
  generated column derived from its parent FK.
- If the schema were not soft-delete-only, this would need real design thought (an explicit
  `BEFORE DELETE` trigger, or dropping the generated-column approach for that relationship) —
  `Restrict` is a free fix here specifically because deletes never reach the database at all.
- Confirm the fix in the generated migration file directly (`ReferentialAction.Restrict` in the
  `AddForeignKey` call), not just in the EF configuration — the configuration is the intent, the
  migration is what actually runs against MySQL.

## Related

- [[orders-service-design]] — the Cart section documents `active_cart_id`/`active_user_id` and
  now cross-references this lesson.
- [[2026-08-25-cart-endpoints-design]] — the spec this schema came from.
- [[soft-delete]] — why `Restrict` is a no-op in practice: the DB user cannot `DELETE`.
- [[db-naming]] — the audit/soft-delete column conventions the generated columns build on.
- [[2026-08-26-spec-said-so-review-checked-the-diff-not-the-spec]] — a sibling finding from
  the same milestone, but the inverse shape: this note is a documentation gap (a migration
  quirk nobody had written down yet), while that note is a code gap (a spec correctly
  specified a behaviour the implementation silently omitted).
