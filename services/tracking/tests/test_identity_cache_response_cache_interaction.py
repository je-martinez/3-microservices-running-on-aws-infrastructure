"""The two caches in ONE request path — the seam neither suite covered.

`test_identity_cache.py` drives `IdentityCache` with a hand-written loader.
`test_cached_reads.py` drives the response cache through the real app. Both were
green while the response cache was serving **zero** cached responses in
production, because the one thing neither exercised is the line between them:
what a *hit* in the identity cache leaves behind on the `CurrentCaller` that the
read handlers then build their response key from.

## Why the existing suite could not see it

`log_identity._resolve_cached` builds its gateway by calling
`shared_cache_gateway()` DIRECTLY — not through `app.dependency_overrides`, which
it cannot consult from a worker thread with no request in hand. Under pytest that
call raises `ValidationError` (the suite deliberately runs without the
DB/Cognito/Redis environment), so `_resolve_cached` took its documented
`identity_cache_unavailable` fallback and ran `_resolve_quietly` on EVERY request.
`_resolve_quietly` calls `caller.resolve_internal_user_id()`, which memoizes — so
in the test suite the caller was always populated and the property always
answered, while in production, from the second request onward, it never was.

The whole suite was therefore testing the identity cache's MISS path and nothing
else. `test_cached_reads.test_second_read_is_a_HIT_carrying_the_ttl` does make two
consecutive requests and does assert a HIT — and it passed throughout, because its
second request re-resolved through gRPC rather than through Redis.

So these tests patch `shared_cache_gateway` at the name `_resolve_cached` imports
it by, pointing it at the SAME `fakeredis` instance the response cache uses. That
single change is what makes the second request take the branch production takes.

## What is asserted, and why it is not vacuous

`test_the_identity_cache_really_HITS_on_the_second_request` is the control: it
proves the patch worked and the second request genuinely skipped the gRPC call
(the stub resolver counts its calls). Without it, every assertion below could pass
because identity resolution silently fell back to gRPC again — the same false
green this file exists to end.
"""

from __future__ import annotations

from collections.abc import Iterator

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.shared.cache.gateway import CacheGateway
from src.shared.grpc.users_client import ResolvedUser
from src.shared.http.caller import get_users_client
from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher
from tests.test_rest_reads import SUB_A, USER_A, as_user, seed

pytestmark = pytest.mark.integration

#: Metrics go nowhere in this suite, exactly as in the `cache_gateway` fixture.
_NOOP_METRICS = NoopMetricsPublisher()


class CountingResolver:
    """The Users gRPC client, counting every resolution it is asked for.

    The count is the whole point: an identity-cache HIT is only provable by the
    ABSENCE of a second call, exactly as `test_identity_cache.CountingLoader`
    proves it one layer down.
    """

    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping
        self.calls: list[str] = []

    def resolve(self, identifier: str) -> ResolvedUser | None:
        self.calls.append(identifier)
        internal = self.mapping.get(identifier)
        if internal is None:
            return None
        return ResolvedUser(
            internal_id=internal,
            cognito_sub=identifier,
            email=None,
            full_name="",
        )


@pytest.fixture
def resolver() -> CountingResolver:
    return CountingResolver({SUB_A: USER_A})


@pytest.fixture
def shared_identity_cache(
    monkeypatch: pytest.MonkeyPatch, redis_double: fakeredis.FakeRedis
) -> None:
    """Make the identity cache REAL for this test, over the same fake Redis.

    Patched at `src.shared.cache.redis_client.shared_cache_gateway` — the module
    attribute, because `_resolve_cached` imports the name inside the function
    body (deliberately: a module-level import would drag `redis` and
    `get_settings` into `create_app`'s import chain). A patch of the importing
    module's namespace would therefore miss it entirely.

    Without this the identity cache raises on construction under pytest and
    `_resolve_cached` degrades to a plain gRPC resolution — which is precisely
    the fallback that hid the bug.
    """
    monkeypatch.setattr(
        "src.shared.cache.redis_client.shared_cache_gateway",
        lambda: CacheGateway(client=redis_double, metrics=_NOOP_METRICS),
    )


@pytest.fixture
def identity_cached_client(
    app: FastAPI, resolver: CountingResolver, shared_identity_cache: None
) -> Iterator[TestClient]:
    """The real app, with a counting Users stub and a LIVE identity cache."""
    app.dependency_overrides[get_users_client] = lambda: resolver
    with TestClient(app) as test_client:
        yield test_client


class TestIdentityHitStillCachesTheResponse:
    """The regression: an identity HIT must not disable the response cache."""

    def test_the_identity_cache_really_HITS_on_the_second_request(
        self,
        identity_cached_client: TestClient,
        session: Session,
        resolver: CountingResolver,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The CONTROL. Every other test here is meaningless without it.

        If the identity cache were still falling back to gRPC, the assertions
        below would pass for the old reason — resolution happening per request —
        and prove nothing about the bug.
        """
        seed(session, order_id="ord_idcache0000000001")
        url = "/v1/trackings/ord_idcache0000000001"
        identity_cached_client.get(url, headers=as_user(SUB_A))
        identity_cached_client.get(url, headers=as_user(SUB_A))

        # Resolved once, over gRPC; the second request read Redis instead.
        assert resolver.calls == [SUB_A]
        assert redis_double.exists(f"identity:sub-to-user:v1:{SUB_A}")

    def test_the_second_read_is_a_response_cache_HIT(
        self,
        identity_cached_client: TestClient,
        session: Session,
    ) -> None:
        """The failing-before/passing-after assertion.

        Before the fix the second request's identity HIT left
        `caller.resolved_internal_user_id` at `None`, `CacheKeys.tracking_order`
        declined to build a key, and this answered `MISS` — every request, for
        the hour the identity entry lives.
        """
        seed(session, order_id="ord_idcache0000000002")
        url = "/v1/trackings/ord_idcache0000000002"

        first = identity_cached_client.get(url, headers=as_user(SUB_A))
        second = identity_cached_client.get(url, headers=as_user(SUB_A))

        assert first.headers["x-cache"] == "MISS"
        assert second.headers["x-cache"] == "HIT"
        assert 0 < int(second.headers["x-cache-ttl"]) <= 60
        assert second.json() == first.json()

    def test_the_response_entry_is_keyed_by_the_CACHED_user_id(
        self,
        identity_cached_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """Not merely "a key exists" — the right `usr_` id is in it.

        A seeding bug that stored the SUB where the `usr_` id belongs would still
        produce a HIT above (both requests would agree on the wrong key), so the
        key's contents are asserted separately.
        """
        seed(session, order_id="ord_idcache0000000003")
        url = "/v1/trackings/ord_idcache0000000003"
        identity_cached_client.get(url, headers=as_user(SUB_A))
        identity_cached_client.get(url, headers=as_user(SUB_A))

        assert redis_double.exists(
            f"tracking:order:v1:{SUB_A}:{USER_A}:ord_idcache0000000003"
        )

    def test_the_list_read_hits_too_on_an_identity_HIT(
        self,
        identity_cached_client: TestClient,
        session: Session,
    ) -> None:
        """The batch read builds its key from the same property. Same bug."""
        seed(session, order_id="ord_idcache0000000004")
        url = "/v1/trackings?order_ids=ord_idcache0000000004"

        first = identity_cached_client.get(url, headers=as_user(SUB_A))
        second = identity_cached_client.get(url, headers=as_user(SUB_A))

        assert first.headers["x-cache"] == "MISS"
        assert second.headers["x-cache"] == "HIT"
        assert second.json() == first.json()

    def test_a_third_read_still_hits(
        self,
        identity_cached_client: TestClient,
        session: Session,
        resolver: CountingResolver,
    ) -> None:
        """Three requests, because the bug's shape was "the first one works".

        A two-request test could in principle pass on an implementation that
        happens to survive one round trip; the reported symptom was three
        consecutive reads all logging `cache_result=miss`, so the test mirrors
        it.
        """
        seed(session, order_id="ord_idcache0000000005")
        url = "/v1/trackings/ord_idcache0000000005"

        results = [
            identity_cached_client.get(url, headers=as_user(SUB_A)).headers["x-cache"]
            for _ in range(3)
        ]

        assert results == ["MISS", "HIT", "HIT"]
        assert resolver.calls == [SUB_A]


class TestSeededCallerStaysHonest:
    """The seeding must not fabricate identity, nor mask a genuine failure."""

    def test_an_unresolvable_caller_is_still_served_and_still_not_cached(
        self,
        app: FastAPI,
        session: Session,
        shared_identity_cache: None,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """A `None` from the identity cache must not seed anything.

        The property's contract is unchanged for a genuinely unresolved caller:
        `None` still means "no key, skip caching". Negatives are never cached
        (see `IdentityCache`), so this also proves the fix did not accidentally
        start persisting one.
        """
        unknown = CountingResolver({})  # resolves nobody
        app.dependency_overrides[get_users_client] = lambda: unknown
        seed(session, order_id="ord_idcache0000000006")

        with TestClient(app) as client:
            url = "/v1/trackings/ord_idcache0000000006"
            first = client.get(url, headers=as_user(SUB_A))
            second = client.get(url, headers=as_user(SUB_A))

        assert first.status_code == 200
        assert [first.headers["x-cache"], second.headers["x-cache"]] == [
            "MISS",
            "MISS",
        ]
        assert redis_double.keys("tracking:*") == []
        # The negative was re-asked rather than cached — both requests called.
        assert unknown.calls == [SUB_A, SUB_A]
