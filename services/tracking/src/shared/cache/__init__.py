"""The HTTP response cache and the identity-mapping cache.

Four pieces, matching the shared design ([[2026-08-25-response-caching-layer-design]]):

* `keys.py`           — key construction, and the rules that keep a key from
                        being shared between two callers.
* `gateway.py`        — the transport: Redis, JSON, the 50ms budget, and the
                        metric/span/log emission for every operation.
* `identity_cache.py` — the `cognito_sub -> user_id` mapping, which must be
                        resolved BEFORE a response key can be built.
* `invalidation.py`   — what the carrier webhook and the account-deletion
                        cascade delete after their write lands.

Governing rule for all four: **the cache may never break or degrade a read.**
Every Redis touch is wrapped, timed and swallowed; a failure answers
`X-Cache: BYPASS` and the request proceeds against MySQL.

Deliberately does NOT re-export `redis_client`: importing that module pulls in
`redis` and `get_settings`, and `test_openapi_spec.py` builds the app with no
environment at all. Callers that need the process-wide gateway import
`src.shared.cache.redis_client` directly, from inside a function.
"""

from .gateway import CacheEntry, CacheGateway, NullCacheGateway
from .identity_cache import IdentityCache
from .invalidation import invalidate_tracking, invalidate_user
from .keys import CacheKeys

__all__ = [
    "CacheEntry",
    "CacheGateway",
    "CacheKeys",
    "IdentityCache",
    "NullCacheGateway",
    "invalidate_tracking",
    "invalidate_user",
]
