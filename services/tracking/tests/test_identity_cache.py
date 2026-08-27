"""The `cognito_sub -> user_id` cache.

This one is consulted BEFORE a response key can be built, because every
response key carries `user_id`. A hit here removes the gRPC call to Users from
the critical path of what should be a fast read.
"""

import fakeredis
import pytest

from src.shared.cache.gateway import CacheGateway
from src.shared.cache.identity_cache import IdentityCache
from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher

SUB_A = "11111111-1111-4111-8111-111111111111"
USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"


class CountingLoader:
    """The gRPC resolution, counted so a hit is provable by absence."""

    def __init__(self, answer: str | None) -> None:
        self.answer = answer
        self.calls = 0

    def __call__(self) -> str | None:
        self.calls += 1
        return self.answer


class ExplodingRedis:
    """Every operation fails, exactly as an unreachable Redis does."""

    def __getattr__(self, name: str):  # noqa: ANN202
        def boom(*args: object, **kwargs: object) -> None:
            raise ConnectionError("redis is down")

        return boom


@pytest.fixture
def cache() -> IdentityCache:
    return IdentityCache(
        gateway=CacheGateway(
            client=fakeredis.FakeRedis(decode_responses=True),
            metrics=NoopMetricsPublisher(),
        )
    )


class TestResolve:
    def test_a_miss_calls_the_loader_and_returns_its_answer(
        self, cache: IdentityCache
    ) -> None:
        loader = CountingLoader(USER_A)
        assert cache.resolve(SUB_A, loader) == USER_A
        assert loader.calls == 1

    def test_a_second_resolve_does_NOT_call_the_loader(
        self, cache: IdentityCache
    ) -> None:
        """The whole point: no gRPC call on the second request."""
        loader = CountingLoader(USER_A)
        cache.resolve(SUB_A, loader)
        assert cache.resolve(SUB_A, loader) == USER_A
        assert loader.calls == 1

    def test_a_None_answer_is_NOT_cached(self, cache: IdentityCache) -> None:
        """An unresolvable sub must stay unresolvable, not stick for an hour.

        A `None` here means Users had no record, or Users was unreachable, or
        no client could be built. Caching that for the 1h TTL would keep a
        user's own `user_id` out of their keys long after the cause cleared —
        and since a `None` user_id disables caching entirely (see
        `CacheKeys`), it would silently switch the cache off for that caller
        for an hour. So negatives are re-asked every request; the cost is the
        gRPC call they would have paid anyway.
        """
        loader = CountingLoader(None)
        assert cache.resolve(SUB_A, loader) is None
        assert cache.resolve(SUB_A, loader) is None
        assert loader.calls == 2

    def test_two_subs_do_not_share_an_entry(self, cache: IdentityCache) -> None:
        other = "22222222-2222-4222-8222-222222222222"
        cache.resolve(SUB_A, CountingLoader(USER_A))
        loader = CountingLoader("usr_bbbbbbbbbbbbbbbbbbbbb")
        assert cache.resolve(other, loader) == "usr_bbbbbbbbbbbbbbbbbbbbb"
        assert loader.calls == 1

    def test_stored_with_the_one_hour_ttl(self, cache: IdentityCache) -> None:
        cache.resolve(SUB_A, CountingLoader(USER_A))
        entry = cache._gateway.get(f"identity:sub-to-user:v1:{SUB_A}")
        assert entry.ttl_remaining is not None
        assert 3500 < entry.ttl_remaining <= 3600


class TestFailOpen:
    def test_a_dead_redis_still_resolves_through_the_loader(self) -> None:
        cache = IdentityCache(
            gateway=CacheGateway(
                client=ExplodingRedis(), metrics=NoopMetricsPublisher()
            )
        )
        loader = CountingLoader(USER_A)
        assert cache.resolve(SUB_A, loader) == USER_A
        assert loader.calls == 1

    def test_a_loader_that_raises_yields_None_not_an_exception(
        self, cache: IdentityCache
    ) -> None:
        """`resolve_internal_user_id` raises UnknownUserError on an unknown sub."""

        def boom() -> str | None:
            raise RuntimeError("users is down")

        assert cache.resolve(SUB_A, boom) is None
