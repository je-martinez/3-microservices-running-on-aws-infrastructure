"""`GET /v1/trackings/{order_id}` and `GET /v1/trackings` behind the cache.

Drives the REAL app through `TestClient` against real MySQL and a fake Redis —
routing, dependencies, response models and headers all exercised, because a
cache bug that only appears through the HTTP surface (a header stripped by a
response model, a key built from the wrong dependency) is exactly the kind a
direct function call cannot see.
"""

import logging
from collections.abc import Iterator

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from src.shared.cache.gateway import CacheGateway
from src.shared.http.cache_dependencies import get_cache_gateway
from src.shared.http.caller import get_users_client
from src.shared.logging.context_filter import LogContextFilter
from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher
from tests.test_rest_reads import SUB_A, SUB_B, USER_A, USER_B, as_user, seed

pytestmark = pytest.mark.integration


class StubResolver:
    """Stands in for the Users gRPC client, resolving sub -> usr_ id."""

    def __init__(self, mapping: dict[str, str]) -> None:
        self.mapping = mapping

    def resolve(self, identifier: str):  # noqa: ANN201 - a ResolvedUser or None
        from src.shared.grpc.users_client import ResolvedUser

        internal = self.mapping.get(identifier)
        if internal is None:
            return None
        return ResolvedUser(
            internal_id=internal,
            cognito_sub=identifier,
            email=None,
            full_name="",
        )


class ExplodingRedis:
    """Every operation fails, exactly as an unreachable Redis does."""

    def __getattr__(self, name: str):  # noqa: ANN202
        def boom(*args: object, **kwargs: object) -> None:
            raise ConnectionError("redis is down")

        return boom


@pytest.fixture
def resolving_app(app: FastAPI) -> FastAPI:
    """The app with identity resolution stubbed for BOTH test users.

    Without this, `_resolve_quietly` swallows the failure to reach Users and
    every caller arrives with `user_id is None` — which legitimately disables
    caching (see `CacheKeys`), so every assertion below would fail for a
    reason that has nothing to do with what it is testing.
    """
    app.dependency_overrides[get_users_client] = lambda: StubResolver(
        {SUB_A: USER_A, SUB_B: USER_B}
    )
    return app


@pytest.fixture
def resolving_client(resolving_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(resolving_app) as test_client:
        yield test_client


class TestSingleReadCaching:
    def test_first_read_is_a_MISS_with_no_ttl_header(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_cache0000000000001")
        response = resolving_client.get(
            "/v1/trackings/ord_cache0000000000001", headers=as_user(SUB_A)
        )
        assert response.status_code == 200
        assert response.headers["x-cache"] == "MISS"
        assert "x-cache-ttl" not in response.headers

    def test_second_read_is_a_HIT_carrying_the_ttl(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_cache0000000000002")
        url = "/v1/trackings/ord_cache0000000000002"
        first = resolving_client.get(url, headers=as_user(SUB_A))
        second = resolving_client.get(url, headers=as_user(SUB_A))

        assert second.headers["x-cache"] == "HIT"
        ttl = int(second.headers["x-cache-ttl"])
        assert 0 < ttl <= 60
        assert second.json() == first.json()

    def test_the_key_carries_both_identities_and_the_order_id(
        self,
        resolving_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The scoping is the key, so the key shape is worth asserting once."""
        seed(session, order_id="ord_cache0000000000009")
        resolving_client.get(
            "/v1/trackings/ord_cache0000000000009", headers=as_user(SUB_A)
        )
        assert redis_double.exists(
            f"tracking:order:v1:{SUB_A}:{USER_A}:ord_cache0000000000009"
        )

    def test_a_404_is_never_cached(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """Only 200s go in. A cached 404 would outlive the tracking's creation."""
        url = "/v1/trackings/ord_cache0000000000003"
        assert resolving_client.get(url, headers=as_user(SUB_A)).status_code == 404
        seed(session, order_id="ord_cache0000000000003")
        second = resolving_client.get(url, headers=as_user(SUB_A))
        assert second.status_code == 200


class TestListReadCaching:
    def test_miss_then_hit(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_cachelist00000001")
        url = "/v1/trackings?order_ids=ord_cachelist00000001"
        first = resolving_client.get(url, headers=as_user(SUB_A))
        second = resolving_client.get(url, headers=as_user(SUB_A))

        assert first.headers["x-cache"] == "MISS"
        assert "x-cache-ttl" not in first.headers
        assert second.headers["x-cache"] == "HIT"
        assert 0 < int(second.headers["x-cache-ttl"]) <= 60
        assert second.json() == first.json()

    def test_two_orderings_of_the_same_ids_share_ONE_entry(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """Normalization is what makes this a HIT rather than a second MISS."""
        seed(session, order_id="ord_cachelist00000002")
        seed(session, order_id="ord_cachelist00000003")

        forward = resolving_client.get(
            "/v1/trackings?order_ids=ord_cachelist00000002,ord_cachelist00000003",
            headers=as_user(SUB_A),
        )
        reversed_ = resolving_client.get(
            "/v1/trackings?order_ids=ord_cachelist00000003,ord_cachelist00000002",
            headers=as_user(SUB_A),
        )

        assert forward.headers["x-cache"] == "MISS"
        assert reversed_.headers["x-cache"] == "HIT"
        assert reversed_.json() == forward.json()

    def test_a_duplicate_id_hits_the_same_entry(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_cachelist00000004")
        url = "/v1/trackings?order_ids=ord_cachelist00000004"
        resolving_client.get(url, headers=as_user(SUB_A))
        duplicated = resolving_client.get(
            f"{url},ord_cachelist00000004", headers=as_user(SUB_A)
        )
        assert duplicated.headers["x-cache"] == "HIT"

    def test_a_list_key_is_recorded_in_the_owner_s_index(
        self,
        resolving_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The index is the ONLY way the webhook can reach a hashed list key."""
        seed(session, order_id="ord_cachelist00000005")
        resolving_client.get(
            "/v1/trackings?order_ids=ord_cachelist00000005", headers=as_user(SUB_A)
        )
        members = redis_double.smembers(f"tracking:index:v1:{SUB_A}:{USER_A}")
        assert any(member.startswith("tracking:list:v1:") for member in members)

    def test_the_over_cap_400_is_never_cached(
        self, resolving_client: TestClient
    ) -> None:
        ids = ",".join(f"ord_{n}" for n in range(101))
        response = resolving_client.get(
            f"/v1/trackings?order_ids={ids}", headers=as_user(SUB_A)
        )
        assert response.status_code == 400
        assert response.headers.get("x-cache") != "HIT"


class TestCrossUserIsolation:
    """NON-NEGOTIABLE: B must never receive A's cached body.

    This is the failure a response cache exists to be suspected of, and it is
    the one that a naive key (order_id only) produces immediately — with a
    200 and a plausible body, so nothing anywhere reports an error.
    """

    def test_B_gets_a_404_for_a_tracking_A_just_cached(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(
            session,
            order_id="ord_isolation00000001",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )
        url = "/v1/trackings/ord_isolation00000001"

        a_response = resolving_client.get(url, headers=as_user(SUB_A))
        assert a_response.status_code == 200
        assert a_response.headers["x-cache"] == "MISS"

        b_response = resolving_client.get(url, headers=as_user(SUB_B))
        assert b_response.status_code == 404
        assert b_response.headers.get("x-cache") != "HIT"

    def test_B_does_not_inherit_A_s_cached_list(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(
            session,
            order_id="ord_isolation00000002",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )
        url = "/v1/trackings?order_ids=ord_isolation00000002"

        a_response = resolving_client.get(url, headers=as_user(SUB_A))
        assert len(a_response.json()["trackings"]) == 1

        b_response = resolving_client.get(url, headers=as_user(SUB_B))
        assert b_response.headers["x-cache"] == "MISS"
        assert b_response.json()["trackings"] == []

    def test_B_reading_first_does_not_poison_A(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """The same isolation in the other direction — an empty body cached."""
        seed(
            session,
            order_id="ord_isolation00000003",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )
        url = "/v1/trackings?order_ids=ord_isolation00000003"

        assert (
            resolving_client.get(url, headers=as_user(SUB_B)).json()["trackings"] == []
        )
        a_response = resolving_client.get(url, headers=as_user(SUB_A))
        assert len(a_response.json()["trackings"]) == 1


class TestUnresolvedIdentity:
    """A caller whose `user_id` cannot be resolved is served, never cached."""

    def test_read_succeeds_with_no_caching_when_user_id_is_unknown(
        self, app: FastAPI, session: Session, redis_double: fakeredis.FakeRedis
    ) -> None:
        """`app`, not `resolving_app`: nothing resolves this sub.

        `_resolve_quietly` swallows the failure, so the caller reaches the
        handler authenticated but with `user_id is None`. The read must still
        answer correctly; it simply is not cached, because a key with a `None`
        segment is not a key this service is willing to write.
        """
        seed(session, order_id="ord_nouserid000000001")
        with TestClient(app) as client:
            url = "/v1/trackings/ord_nouserid000000001"
            first = client.get(url, headers=as_user(SUB_A))
            second = client.get(url, headers=as_user(SUB_A))

        assert first.status_code == 200
        assert first.headers["x-cache"] == "MISS"
        assert second.headers["x-cache"] == "MISS"
        # And nothing was written: not a key with a "None" segment, not anything.
        assert redis_double.keys("tracking:*") == []


class TestFailOpen:
    def test_a_dead_redis_answers_BYPASS_with_a_correct_body(
        self, resolving_app: FastAPI, session: Session
    ) -> None:
        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=NoopMetricsPublisher()
        )
        order_id = "ord_bypass0000000001"
        seed(session, order_id=order_id)
        with TestClient(resolving_app) as client:
            response = client.get(f"/v1/trackings/{order_id}", headers=as_user(SUB_A))

        assert response.status_code == 200
        assert response.headers["x-cache"] == "BYPASS"
        assert "x-cache-ttl" not in response.headers
        assert response.json()["order_id"] == order_id

    def test_a_dead_redis_answers_BYPASS_on_the_list_read_too(
        self, resolving_app: FastAPI, session: Session
    ) -> None:
        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=NoopMetricsPublisher()
        )
        seed(session, order_id="ord_bypass0000000002")
        with TestClient(resolving_app) as client:
            response = client.get(
                "/v1/trackings?order_ids=ord_bypass0000000002",
                headers=as_user(SUB_A),
            )

        assert response.status_code == 200
        assert response.headers["x-cache"] == "BYPASS"
        assert len(response.json()["trackings"]) == 1


class TestKillSwitch:
    """`CACHE_ENABLED=false` makes the cache invisible.

    The negative assertion below (`redis_double.keys("*") == []`) CANNOT stand on
    its own, and the reason is worth stating where the test is rather than in a
    review comment. A cache that is merely BROKEN — one whose `set` silently
    writes nothing, which is precisely what fail-open produces when the client is
    missing a command the gateway calls — leaves the keyspace just as empty as a
    cache that is switched off. So "Redis was not touched" passes for the wrong
    reason, and the switch looks tested while nothing about it is.

    `test_the_cache_IS_used_when_enabled` is the paired positive: same fixtures,
    same route, switch ON, asserting Redis was actually written AND that the
    second read reports `HIT`. Verified by mutation, not by inspection — stubbing
    `CacheGateway.set` to a no-op leaves the negative test green and turns the
    positive one red, which is the only arrangement under which the pair means
    anything.
    """

    def test_the_cache_IS_used_when_enabled(
        self,
        resolving_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
        cache_gateway: CacheGateway,
    ) -> None:
        """The control for the test below. Without it that one proves nothing."""
        seed(session, order_id="ord_killswitch0000002")
        url = "/v1/trackings/ord_killswitch0000002"

        first = resolving_client.get(url, headers=as_user(SUB_A))
        second = resolving_client.get(url, headers=as_user(SUB_A))

        # Redis really was written — not "the body was correct", which a
        # BYPASSing cache also produces.
        assert redis_double.keys("*") != []
        # And the gateway really reported a hit, not merely a 200.
        assert first.headers["x-cache"] == "MISS"
        assert second.headers["x-cache"] == "HIT"
        assert cache_gateway.get(
            f"tracking:order:v1:{SUB_A}:{USER_A}:ord_killswitch0000002"
        ).hit is True

    def test_CACHE_ENABLED_false_emits_NO_header_at_all(
        self,
        engine: Engine,
        redis_double: fakeredis.FakeRedis,
        session: Session,
    ) -> None:
        """Not BYPASS and not MISS — absent. A disabled cache is invisible."""
        from sqlalchemy.orm import sessionmaker

        from src.main import create_app
        from src.shared.cache.gateway import NullCacheGateway
        from src.shared.config.settings import Settings, get_settings
        from src.shared.http.dependencies import get_read_session, get_write_session
        from tests.conftest import TEST_CARRIER_API_KEY

        factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        def override_read() -> Iterator[Session]:
            db = factory()
            try:
                yield db
            finally:
                db.close()

        application = create_app()
        application.dependency_overrides[get_read_session] = override_read
        application.dependency_overrides[get_write_session] = override_read
        application.dependency_overrides[get_settings] = lambda: Settings(
            database_writer_url="mysql+pymysql://unused/unused",
            database_reader_url="mysql+pymysql://unused/unused",
            grpc_api_key="unused-grpc-key",
            tracking_carrier_api_key=TEST_CARRIER_API_KEY,
            cache_enabled=False,
        )
        application.dependency_overrides[get_cache_gateway] = NullCacheGateway
        application.dependency_overrides[get_users_client] = lambda: StubResolver(
            {SUB_A: USER_A}
        )

        seed(session, order_id="ord_killswitch0000001")
        with TestClient(application) as client:
            response = client.get(
                "/v1/trackings/ord_killswitch0000001", headers=as_user(SUB_A)
            )

        assert response.status_code == 200
        assert "x-cache" not in response.headers
        assert "x-cache-ttl" not in response.headers
        assert redis_double.keys("*") == []


class TestCacheResultReachesTheLogContext:
    """`cache_result` is on every log line of a cached read.

    Worth its own test because the failure mode is SILENT. `merge_log_context`
    filters through the fixed `_ALLOWED_KEYS` frozenset in
    `shared/logging/log_context.py`; a key absent from it is dropped with no
    error, no warning and no exception. So forgetting to allowlist the field
    produces a cache that works perfectly and is completely unobservable, and
    nothing anywhere fails.

    Asserted on the MIDDLEWARE's `request completed` line, which is emitted
    after the handler returns — so it also proves the merge landed on the
    request's own context rather than on a threadpool copy that unwinds.

    `context_filtered_caplog`, not plain `caplog`: the context reaches a record
    through `LogContextFilter`, which `logging/config.py` installs on the root
    HANDLER. `caplog` brings its own handler, so without the filter this would
    assert against a pipeline the service does not run — see the identical
    fixture in `tests/test_request_id.py`.
    """

    @pytest.fixture
    def context_filtered_caplog(
        self, caplog: pytest.LogCaptureFixture
    ) -> Iterator[pytest.LogCaptureFixture]:
        log_filter = LogContextFilter()
        caplog.handler.addFilter(log_filter)
        try:
            yield caplog
        finally:
            caplog.handler.removeFilter(log_filter)

    @staticmethod
    def _results(caplog: pytest.LogCaptureFixture) -> list[str]:
        return [
            record.cache_result
            for record in caplog.records
            if record.getMessage() == "request completed"
            and hasattr(record, "cache_result")
        ]

    def test_a_miss_then_a_hit_are_both_recorded(
        self,
        resolving_client: TestClient,
        session: Session,
        context_filtered_caplog: pytest.LogCaptureFixture,
    ) -> None:
        seed(session, order_id="ord_logctx00000000001")
        url = "/v1/trackings/ord_logctx00000000001"

        with context_filtered_caplog.at_level(logging.INFO):
            resolving_client.get(url, headers=as_user(SUB_A))
            resolving_client.get(url, headers=as_user(SUB_A))

        assert self._results(context_filtered_caplog) == ["miss", "hit"]

    def test_a_bypass_is_recorded_as_bypass_not_as_a_miss(
        self,
        resolving_app: FastAPI,
        session: Session,
        context_filtered_caplog: pytest.LogCaptureFixture,
    ) -> None:
        """An outage must not read as a poor hit rate on the dashboard."""
        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=NoopMetricsPublisher()
        )
        seed(session, order_id="ord_logctx00000000002")

        with (
            context_filtered_caplog.at_level(logging.INFO),
            TestClient(resolving_app) as client,
        ):
            client.get(
                "/v1/trackings/ord_logctx00000000002", headers=as_user(SUB_A)
            )

        assert self._results(context_filtered_caplog) == ["bypass"]

    def test_the_list_read_records_it_too(
        self,
        resolving_client: TestClient,
        session: Session,
        context_filtered_caplog: pytest.LogCaptureFixture,
    ) -> None:
        seed(session, order_id="ord_logctx00000000003")
        url = "/v1/trackings?order_ids=ord_logctx00000000003"

        with context_filtered_caplog.at_level(logging.INFO):
            resolving_client.get(url, headers=as_user(SUB_A))
            resolving_client.get(url, headers=as_user(SUB_A))

        assert self._results(context_filtered_caplog) == ["miss", "hit"]
