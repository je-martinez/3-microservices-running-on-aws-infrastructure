"""What the carrier webhook clears, and what it can afford not to know.

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
