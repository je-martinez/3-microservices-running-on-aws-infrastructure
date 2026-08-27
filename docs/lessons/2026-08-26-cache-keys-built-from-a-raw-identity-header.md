---
title: "A cache key built from a raw identity header cannot be invalidated by a canonical identity"
type: lesson
area: shared
status: active
created: 2026-08-26
updated: 2026-08-26
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/critical
related:
  - "[[x-cache-response-header]]"
  - "[[2026-08-25-response-caching-layer-design]]"
  - "[[testing]]"
  - "[[current-caller-context]]"
---

# A cache key built from a raw identity header cannot be invalidated by a canonical identity

## Finding

All three services (Users, Orders, Tracking) cache HTTP responses in Redis behind the
`X-Cache` header ([[x-cache-response-header]]). Per-user keys carry both a caller identity and
the internal `usr_` id, e.g. `orders:my-orders:v1:{caller}:{user_id}:t0`, plus a per-user key
index `orders:index:v1:{caller}` and an identity mapping `identity:sub-to-user:v1:{caller}`.

The first key segment, `{caller}`, is the raw `x-user-id` header value, stored verbatim. Both
services' own code claimed otherwise: Orders' `InternalEndpoints.cs` said "no cache key is
reachable by user_id alone", and Tracking's `CacheKeys.identity()` said "Keyed on the sub
alone." Both comments were wrong, and both were written by the same reasoning that produced
the bug below.

Users' gRPC `GetUserById` deliberately resolves **either** a `usr_` internal id **or** a
Cognito sub — that duality is intentional. Clients legitimately send either identifier, and the
E2E suite plus `e2e/support/api-client.ts` send the `usr_` id on the direct path. The same
person therefore produces two different cache keys depending on which identifier they
authenticate with.

`DELETE /v1/users/me` cascades to Orders and Tracking with the **canonical** identities
(`cognito_sub`, a real UUID, and `user_id`, the `usr_` id). Invalidation deleted keys built
from the canonical sub — keys that were never written, because the client that populated the
cache had authenticated with the `usr_` id instead. The live entries survived their full TTL,
serving a deleted account's data: up to 2 minutes for orders, 5 for the profile, and **1 hour**
for the identity mapping.

**Evidence (reproduced three times):** the cascade logged `internal_delete_by_user_succeeded`,
`DELETE /v1/users/me` returned `204`, the Redis key count went `2 -> 2` (nothing was removed),
`EXISTS orders:index:v1:65fdbda1-...` returned `0` (the key the cascade tried to delete never
existed in the first place), and a re-read of `GET /v1/orders/my-orders` returned
`X-Cache: HIT` with the deleted user's full order.

## Why no test caught it

- Layer-1 (unit/integration) tests in both services passed, because they warm a key and
  invalidate it using the **same** identity in both steps. The bug only appears when the two
  disagree, and no unit test arranged that disagreement.
- Invalidation is deliberately fail-open and swallows its own errors (per the cache's
  fail-open contract, [[x-cache-response-header]]), so a broken invalidation still produces a
  clean `204` and a green suite — there is no error path for a test to catch.
- No E2E test asserted the intersection at all. A coverage audit flagged this exact gap as the
  top risk hours before the suite happened to expose it anyway.
- The E2E test that finally caught it did so **by accident**: its precondition read
  (`expect(await orderIdsFor(...)).toContain(...)`) warms the cache as a side effect, so the
  post-delete read hit a warm entry. Had that precondition been written any other way — or read
  through a fresh, cold key — the bug would still be shipping today.
- Tracking's own test fixture nearly hid it a second time: seeding a row with the default UUID
  sub makes a `usr_`-id header read return `404`, so nothing gets cached and every assertion
  passes against genuinely broken invalidation code.

## The fix, and the trade-off deliberately accepted

The fix chosen: **invalidate by both identifiers**. The deletion cascade already knows both
`cognito_sub` and `user_id`, so it now sweeps both key namespaces and deduplicates. This closes
the leak — every alias a client could have cached under is now covered by the cascade.

**Deliberately not chosen: normalizing cache keys onto one canonical identity at write time.**
Record this as an accepted trade-off, not an oversight:

- The same person still produces two separate cache entries depending on which identifier they
  authenticate with, which wastes Redis memory and yields a lower real hit-rate than the
  `X-Cache` design assumes (a request following the `usr_`-id path never hits an entry warmed
  by the sub path, and vice versa).
- Normalizing at write time (resolve to one canonical identity before building any key) remains
  the actual fix for the hit-rate cost, if it is ever worth doing. It was not done here because
  the deletion leak was the urgent problem and "invalidate by both" closes it with a much
  smaller, more contained change than rewriting every key-building call site across three
  services.

## The transferable lesson

**A cache key derived from a client-supplied identifier is only invalidatable by a caller
holding that same identifier.** Any code path that invalidates using a canonical identity — a
deletion cascade, a background job, an admin action — will silently miss keys written under an
alias it doesn't know about. Either normalize the identity at the point the key is built, or
accept that every invalidation path must enumerate and sweep every alias a key could have been
built from. Silence is the default failure mode here: a mismatched invalidation looks
identical, from the caller's side, to a successful one.

## How to apply

- Before trusting a comment that says a cache key is "keyed on X alone," check every call site
  that **builds** the key, not just the one being read — a resolver that accepts more than one
  identifier form (as `GetUserById` deliberately does here) is exactly the shape that produces
  a false claim like this.
- When a deletion/invalidation flow is fail-open, its `204`/success response proves nothing
  about whether the right keys were actually removed. Verify with `EXISTS`/`SCAN` against
  Redis directly, not just the HTTP status code.
- Write at least one test that **deliberately disagrees**: warm a cache entry under one
  identity alias and invalidate under a different (but same-user) alias, and assert the entry
  is gone. A test that always uses the same identity for both steps cannot detect this class of
  bug no matter how many times it's run.

## Related

- [[x-cache-response-header]] — the cache contract this bug lives inside; carries a pointer to
  this lesson.
- [[2026-08-25-response-caching-layer-design]] — the design spec for the caching layer, whose
  key-naming and invalidation sections this finding directly concerns.
- [[testing]] — the layered-testing convention; this bug is a concrete case of a class no layer
  was built to catch (see "Why no test caught it" above).
- [[current-caller-context]] — the pattern governing how caller identity is resolved per
  request; the `identity` vs. resolved-`user_id` split this pattern documents is the same split
  that produced two divergent cache-key aliases.
