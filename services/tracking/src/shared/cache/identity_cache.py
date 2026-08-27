"""The `cognito_sub -> user_id` mapping cache.

## Why this exists at all

Every response key carries `user_id` as well as `cognito_sub`. `user_id` is not
on the request — it is an internal `usr_` id that only Users knows, and Tracking
obtains it with a gRPC call. So building a response key requires resolving it
FIRST, on every request, cache hit included. Without this, a "fast" cache hit
would still pay a network round trip to another service, which is most of the
latency the response cache was supposed to remove.

## Why TTL-only invalidation is correct here, not a gap

A `cognito_sub` never resolves to a different `user_id` while the account exists,
so a stale entry cannot serve a WRONG answer — only a late one. Users' Cognito
webhook accepts exactly two `triggerSource` values
(`PostConfirmation_ConfirmSignUp`, `PostConfirmation_ConfirmForgotPassword`),
neither of which is an identity change, so nothing short of a deletion could make
an entry wrong.

The one case that CAN — an account that has stopped existing — is no longer left
to the TTL. `DELETE /v1/trackings/by-user`, the account-deletion cascade's leg
here, deletes this key explicitly through `invalidation.invalidate_user`. The 1h
TTL remains the backstop for the path where that eviction could not run (a Redis
outage during the cascade, which fails open by design).

## Negatives are never cached

A `None` answer means one of: Users has no record, Users was unreachable, or no
client could be built (`log_identity._resolve_quietly` collapses all three).
Caching that would keep a real user's `user_id` out of their keys for an hour
after the cause cleared — and because `CacheKeys` skips caching entirely when
`user_id` is None, it would quietly disable the response cache for that caller
for the whole hour. Re-asking each request costs exactly the call the request
would have made anyway.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from src.shared.cache.gateway import CacheGateway, NullCacheGateway
from src.shared.cache.keys import CacheKeys

logger = logging.getLogger(__name__)

#: One hour. Long, because the mapping is effectively immutable; bounded, because
#: a deleted account is the one case where it could be wrong.
IDENTITY_TTL_SECONDS = 3600


class IdentityCache:
    """Resolves `cognito_sub -> user_id`, consulting Redis first."""

    def __init__(self, *, gateway: CacheGateway | NullCacheGateway) -> None:
        self._gateway = gateway

    def resolve(
        self, cognito_sub: str, loader: Callable[[], str | None]
    ) -> str | None:
        """The cached mapping, falling back to `loader` on a miss.

        `loader` is the expensive path — in practice
        `CurrentCaller.resolve_internal_user_id`, wrapped so its
        `UnknownUserError` becomes a `None`. It is allowed to raise; anything it
        raises is swallowed into `None`, because this whole mechanism is an
        optimization on top of an enrichment that was already documented never to
        fail a request.
        """
        key = CacheKeys.identity(cognito_sub)
        entry = self._gateway.get(key)
        if entry.hit and isinstance(entry.value, str) and entry.value:
            return entry.value

        user_id = self._load(loader)
        if user_id:
            self._gateway.set(key, user_id, IDENTITY_TTL_SECONDS)
        return user_id

    @staticmethod
    def _load(loader: Callable[[], str | None]) -> str | None:
        """Run the loader, turning ANY failure into `None`.

        Deliberately broad, and for the same reason
        `log_identity._resolve_quietly` is: a narrow `except` listing the
        foreseen failures is how that module broke the first time — the
        unforeseen one still `500`'d the request. `Exception`, not
        `BaseException`, so a `CancelledError` from a disconnecting client keeps
        propagating.
        """
        try:
            return loader()
        except Exception:  # noqa: BLE001 - identity resolution never fails a read
            logger.debug("identity_cache_loader_failed", exc_info=True)
            return None
