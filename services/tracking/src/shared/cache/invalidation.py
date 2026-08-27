"""What a write clears after it lands — and what it can afford not to know.

Two callers, two shapes of eviction:

* `invalidate_tracking` — the carrier webhook. One order changed status.
* `invalidate_user` — the account-deletion cascade. A whole person is gone,
  including their `cognito_sub -> user_id` mapping.

Both run STRICTLY AFTER their transaction commits, scheduled as a `BackgroundTask`
rather than called inline; see the long comment in `carrier_router.py` for why the
ordering is a property of the ASGI response cycle and not a timing hope.


## The webhook has no caller identity

`PUT /v1/trackings/{order_id}/status` authenticates with `x-api-key` and receives
no `x-user-id` at all — its gateway route is declared `auth = false`
(`services/tracking/CLAUDE.md` §5a). So it cannot build a key carrying
`{sub}:{user_id}` from the request. The owner comes off the PERSISTED ROW
instead: `update_tracking_status` returns the `Tracking` entity, and
`Tracking.cognito_sub` is the same value the reads' ownership filter compares
against. That is the only identity in play here, and it is the right one.

## Why `user_id` is not needed to invalidate

The single-read key embeds BOTH identities, but the webhook holds only the sub —
the row carries a `user_id` too, and the two are read together, so the exact key
IS reconstructible. The list keys are not, at any price: each embeds a sha256 of
an arbitrary caller-supplied id list. Those are cleared through the per-user
index (`CacheKeys.user_index`), a Redis SET the read path adds every list key to
as it writes it.

**Not `KEYS` and not `SCAN`.** Both are O(N) over the entire keyspace, `KEYS`
blocks the server for the duration of the sweep, and putting either on a write
path makes every carrier callback pay for the size of the whole cache.

## A NULL `cognito_sub` is a no-op, and that is safe

The column is nullable (`domain/models.py`): a caller predating the field creates
successfully, and `""` is normalized to NULL. Such a row is **unreachable** over
both user-scoped reads — the filter compares against a sub, and NULL matches
nobody, including the rightful owner. A row that can never be read can never have
been cached, so there is no entry to evict. The function returns without touching
Redis, and the status update proceeds.
"""

from __future__ import annotations

import logging

from src.shared.cache.gateway import CacheGateway, NullCacheGateway
from src.shared.cache.keys import CacheKeys

logger = logging.getLogger(__name__)


def invalidate_tracking(
    gateway: CacheGateway | NullCacheGateway,
    *,
    order_id: str,
    cognito_sub: str | None,
    user_id: str | None,
) -> None:
    """Evict everything a status change on `order_id` could have made stale.

    Never raises: the gateway swallows its own failures, and this adds no new
    failure mode of its own. A missed eviction costs at most the 60s TTL of the
    entries it failed to clear — which is precisely why the TTL is short.
    """
    if not cognito_sub:
        # See the module docstring: an unreachable row was never cached.
        logger.debug(
            "cache_invalidation_skipped",
            extra={
                "app_event": "cache_invalidation_skipped",
                "reason": "no_owner_sub",
                "order_id": order_id,
            },
        )
        return

    if not user_id:
        # Both key shapes embed `user_id`, so without one there is nothing
        # addressable to delete. `Tracking.user_id` is NOT NULL, so this is
        # defensive rather than a live path — but a `None` slipping through would
        # otherwise build `tracking:index:v1:<sub>:None` and delete a key nobody
        # ever wrote, which reads as a successful invalidation while evicting
        # nothing.
        logger.debug(
            "cache_invalidation_skipped",
            extra={
                "app_event": "cache_invalidation_skipped",
                "reason": "no_owner_user_id",
                "order_id": order_id,
            },
        )
        return

    key = CacheKeys.tracking_order(cognito_sub, user_id, order_id)
    if key is not None:
        gateway.invalidate(key)
    gateway.invalidate_index(CacheKeys.user_index(cognito_sub, user_id))

    logger.info(
        "cache_invalidated",
        extra={
            "app_event": "cache_invalidated",
            "order_id": order_id,
            "cognito_sub": cognito_sub,
        },
    )


def invalidate_user(
    gateway: CacheGateway | NullCacheGateway,
    *,
    cognito_sub: str,
    user_id: str,
) -> None:
    """Evict everything the account-deletion cascade leaves behind.

    Called by `DELETE /v1/trackings/by-user` — the leg Users invokes when an
    account is deleted — and, unlike `invalidate_tracking`, it clears TWO
    namespaces because a deletion invalidates more than one order's worth of
    state:

    * **The response entries**, all of them, through the per-user index. There is
      no `order_id` here at all: the cascade names a person, not a shipment, so
      even the single-read keys — which the webhook CAN reconstruct because it
      holds the order it just wrote — are unreconstructible from this request.
      The index is the only handle on them, which is precisely the case it was
      built for. Not `KEYS`, not `SCAN`, for the reasons in the module docstring.
    * **The identity mapping**, `identity:sub-to-user:v1:{sub}`. Left in place it
      keeps answering `user_id` for a person who no longer exists, for up to its
      full hour (`IDENTITY_TTL_SECONDS`) — the one case `identity_cache.py`
      documents its TTL-only invalidation as bounding, with "when a deletion
      endpoint is built, deleting this key is part of THAT milestone's work".
      This is that work.

    Both identities are REQUIRED here rather than nullable, and the route's
    schema already enforces non-empty strings for both — the cascade's body
    carries exactly the pair a key is built from. The defensive `if not` guards
    `invalidate_tracking` needs (a nullable column read off a row) have no
    counterpart on this path.

    Never raises: every gateway method swallows its own failures, so a Redis
    outage costs at most the entries' own TTL. That matters more here than on the
    webhook — the deletion has already COMMITTED by the time this runs, so
    raising would tell Users the cascade failed when it did not, and fail the
    whole account deletion for the person.
    """
    gateway.invalidate_index(CacheKeys.user_index(cognito_sub, user_id))
    gateway.invalidate(CacheKeys.identity(cognito_sub))

    logger.info(
        "cache_invalidated",
        extra={
            "app_event": "cache_invalidated",
            "reason": "account_deleted",
            "cognito_sub": cognito_sub,
        },
    )
