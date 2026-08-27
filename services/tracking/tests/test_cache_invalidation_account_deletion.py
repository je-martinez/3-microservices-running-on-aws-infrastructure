"""`DELETE /v1/trackings/by-user` clears the user's whole cache footprint.

The account-deletion cascade evicts more than the carrier webhook does, because
it invalidates more: not one order's status, but a person. Two namespaces go —
every response entry of theirs (through the per-user index, the only handle on a
list key whose sha256 suffix nothing can reconstruct) and their
`identity:sub-to-user:v1:{sub}` mapping, which would otherwise keep resolving a
deleted account for the remaining hour of its TTL.

## Every test here WARMS the cache before deleting

A test that deletes against an empty Redis and then asserts the keys are absent
passes identically against a handler that invalidates NOTHING. So each test below
issues real reads first and asserts the entries EXIST, then deletes, then asserts
they are gone. `test_the_warmup_really_populated_both_namespaces` is the explicit
control for that: it is the test that fails first if the seeding stops working,
rather than letting a vacuous green propagate through the rest of the file.

## The identity cache needs a monkeypatch, not a dependency override

`log_identity._resolve_cached` builds its gateway by calling
`shared_cache_gateway()` DIRECTLY, which `app.dependency_overrides` cannot reach.
Under pytest that call raises (the suite runs without a Redis/Cognito
environment), so the identity cache silently degrades to its documented fallback
and NEVER writes an `identity:` key at all — an assertion that such a key is gone
would then pass without the handler doing anything. `shared_identity_cache` below
is the same fixture `test_identity_cache_response_cache_interaction.py` uses, and
for the same reason.
"""

from __future__ import annotations

from collections.abc import Iterator

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.shared.cache.gateway import CacheGateway
from src.shared.http.caller import get_users_client
from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher
from tests.conftest import TEST_GRPC_API_KEY
from tests.test_cached_reads import ExplodingRedis, StubResolver
from tests.test_rest_reads import SUB_A, SUB_B, USER_A, USER_B, as_user, seed

pytestmark = pytest.mark.integration

PATH = "/v1/trackings/by-user"

#: Metrics go nowhere in this suite, exactly as in the `cache_gateway` fixture.
_NOOP_METRICS = NoopMetricsPublisher()


def internal_headers() -> dict[str, str]:
    return {"x-api-key": TEST_GRPC_API_KEY}


def cascade_body(cognito_sub: str, user_id: str) -> dict[str, str]:
    """The cascade's body: BOTH identities, which is what a cache key carries.

    Two distinct values per CLAUDE.md §5b — a Cognito sub and a `usr_` id. A body
    reusing one for both could not fail on a handler that swapped them.
    """
    return {"cognito_sub": cognito_sub, "user_id": user_id}


@pytest.fixture
def shared_identity_cache(
    monkeypatch: pytest.MonkeyPatch, redis_double: fakeredis.FakeRedis
) -> None:
    """Make the identity cache REAL for this test, over the same fake Redis.

    Patched at `src.shared.cache.redis_client.shared_cache_gateway` — the module
    attribute, because `_resolve_cached` imports the name inside the function
    body, so patching the importing module's namespace would miss it.

    Without this, no `identity:` key is ever written and every assertion about
    evicting one is vacuous.
    """
    monkeypatch.setattr(
        "src.shared.cache.redis_client.shared_cache_gateway",
        lambda: CacheGateway(client=redis_double, metrics=_NOOP_METRICS),
    )


@pytest.fixture
def resolving_app(app: FastAPI) -> FastAPI:
    """Identity resolution stubbed for BOTH test users.

    Without it `_resolve_quietly` swallows the failure to reach Users, every
    caller arrives with `user_id is None`, and `CacheKeys` legitimately declines
    to cache — so nothing would be warmed and nothing would be asserted.
    """
    app.dependency_overrides[get_users_client] = lambda: StubResolver(
        {SUB_A: USER_A, SUB_B: USER_B}
    )
    return app


@pytest.fixture
def cascade_client(
    resolving_app: FastAPI, shared_identity_cache: None
) -> Iterator[TestClient]:
    """The real app, with a live identity cache over the same fake Redis.

    A context manager, deliberately: that is what makes `BackgroundTasks` — which
    the eviction is dispatched through — actually run. A bare `TestClient(app)`
    would skip them, and every assertion here would fail for a reason that has
    nothing to do with the handler.
    """
    with TestClient(resolving_app) as test_client:
        yield test_client


def warm(client: TestClient, session: Session, order_id: str) -> None:
    """Seed a tracking and read it both ways, so every key shape exists."""
    seed(session, order_id=order_id)
    client.get(f"/v1/trackings/{order_id}", headers=as_user(SUB_A))
    client.get(f"/v1/trackings?order_ids={order_id}", headers=as_user(SUB_A))


def single_key(order_id: str, sub: str = SUB_A, user: str = USER_A) -> str:
    return f"tracking:order:v1:{sub}:{user}:{order_id}"


def index_key(sub: str = SUB_A, user: str = USER_A) -> str:
    return f"tracking:index:v1:{sub}:{user}"


def identity_key(sub: str = SUB_A) -> str:
    return f"identity:sub-to-user:v1:{sub}"


class TestWarmup:
    """The control. Everything below is vacuous if this fails."""

    def test_the_warmup_really_populated_both_namespaces(
        self,
        cascade_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """Response entries AND an identity mapping, before any deletion.

        Asserted separately from the eviction tests because the two failure modes
        are indistinguishable from the outside: "the handler evicted the keys"
        and "the keys were never written" both end with `exists() == 0`.
        """
        order_id = "ord_delwarm000000001"
        warm(cascade_client, session, order_id)

        assert redis_double.exists(single_key(order_id))
        # The list key's suffix is a sha256 nothing can reconstruct — its
        # presence is asserted through the index that holds it, which is exactly
        # why the index exists.
        members = redis_double.smembers(index_key())
        assert any(m.startswith(f"tracking:list:v1:{SUB_A}:{USER_A}:") for m in members)
        assert redis_double.exists(identity_key())


class TestResponseEntriesAreEvicted:
    def test_every_response_entry_of_theirs_is_gone(
        self,
        cascade_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """Both key shapes, plus the index itself."""
        order_id = "ord_delresp000000001"
        warm(cascade_client, session, order_id)
        assert redis_double.exists(single_key(order_id))

        response = cascade_client.request(
            "DELETE",
            PATH,
            json=cascade_body(SUB_A, USER_A),
            headers=internal_headers(),
        )

        assert response.status_code == 200
        assert redis_double.keys(f"tracking:order:v1:{SUB_A}:*") == []
        assert redis_double.keys(f"tracking:list:v1:{SUB_A}:*") == []
        # The index too: left holding dead keys it would grow without bound.
        assert redis_double.smembers(index_key()) == set()
        assert not redis_double.exists(index_key())

    def test_a_second_user_s_entries_survive(
        self,
        cascade_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The eviction is per-user, and it must actually be scoped.

        An implementation reaching for `KEYS tracking:*` — the shape this design
        forbids — would pass every other test in this file and fail only this
        one.
        """
        mine = "ord_delscope00000001"
        theirs = "ord_delscope00000002"
        warm(cascade_client, session, mine)
        seed(session, order_id=theirs, user_id=USER_B, cognito_sub=SUB_B)
        cascade_client.get(f"/v1/trackings/{theirs}", headers=as_user(SUB_B))
        assert redis_double.exists(single_key(theirs, SUB_B, USER_B))

        cascade_client.request(
            "DELETE",
            PATH,
            json=cascade_body(SUB_A, USER_A),
            headers=internal_headers(),
        )

        assert not redis_double.exists(single_key(mine))
        assert redis_double.exists(single_key(theirs, SUB_B, USER_B))
        assert redis_double.exists(identity_key(SUB_B))


class TestIdentityMappingIsEvicted:
    def test_the_sub_to_user_mapping_is_gone(
        self,
        cascade_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """Leaving it would resolve a deleted user for up to a full hour.

        `IDENTITY_TTL_SECONDS` is 3600 and the mapping is written on the FIRST
        read, so without this eviction the deleted account keeps producing a
        `usr_` id — and cache keys under it — long after the row is gone.
        """
        order_id = "ord_delident00000001"
        warm(cascade_client, session, order_id)
        assert redis_double.exists(identity_key())

        response = cascade_client.request(
            "DELETE",
            PATH,
            json=cascade_body(SUB_A, USER_A),
            headers=internal_headers(),
        )

        assert response.status_code == 200
        assert not redis_double.exists(identity_key())


class TestOrdering:
    def test_the_eviction_happens_AFTER_the_commit(
        self,
        cascade_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The ordering the design turns on, asserted from the outside.

        A repopulation racing an uncommitted delete is not reproducible in a
        single-threaded `TestClient`, but its precondition is: by the time the
        response has been returned the keys must be gone AND the rows must
        already be soft-deleted. Both hold only if the eviction ran after
        `write_session`'s commit — an inline eviction would still have cleared
        the keys, but a subsequent read would find the rows alive and repopulate.

        The follow-up read is what makes that concrete: it 404s (the rows are
        committed as deleted) and it does NOT leave a new entry behind.
        """
        order_id = "ord_delorder00000001"
        warm(cascade_client, session, order_id)

        cascade_client.request(
            "DELETE",
            PATH,
            json=cascade_body(SUB_A, USER_A),
            headers=internal_headers(),
        )

        after = cascade_client.get(
            f"/v1/trackings/{order_id}", headers=as_user(SUB_A)
        )
        assert after.status_code == 404
        # A 404 is not cached, so nothing was written back either.
        assert not redis_double.exists(single_key(order_id))

    def test_a_db_fault_schedules_no_eviction(
        self,
        cascade_client: TestClient,
        session: Session,
        monkeypatch: pytest.MonkeyPatch,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """Nothing was deleted, so nothing may be evicted.

        Structural rather than a guard: the failure branch raises out of the
        handler before `add_task` is reached. Evicting for a deletion that never
        landed would throw away a live user's whole cache footprint — including
        the identity mapping every one of their keys is built from.
        """
        from src.features.tracking.api import internal_router

        order_id = "ord_delfault00000001"
        warm(cascade_client, session, order_id)

        def explode(*args: object, **kwargs: object) -> int:
            raise RuntimeError("connection reset by peer")

        monkeypatch.setattr(internal_router, "delete_by_user", explode)

        with pytest.raises(RuntimeError):
            cascade_client.request(
                "DELETE",
                PATH,
                json=cascade_body(SUB_A, USER_A),
                headers=internal_headers(),
            )

        assert redis_double.exists(single_key(order_id))
        assert redis_double.exists(identity_key())


class TestFailOpen:
    def test_a_dead_redis_does_not_fail_the_cascade(
        self, resolving_app: FastAPI, session: Session
    ) -> None:
        """The deletion has already COMMITTED by the time the eviction runs.

        Raising here would answer Users a 500 for a cascade leg that DID happen,
        which fails the whole account deletion for the person while their data is
        already gone. User-approved fail-open, not a shortcut.
        """
        from src.shared.http.cache_dependencies import get_cache_gateway

        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=_NOOP_METRICS
        )
        seed(session, order_id="ord_delbypass0000001")

        with TestClient(resolving_app) as client:
            response = client.request(
                "DELETE",
                PATH,
                json=cascade_body(SUB_A, USER_A),
                headers=internal_headers(),
            )

        assert response.status_code == 200
        assert response.json() == {"deleted": 1}

    def test_the_failure_logs_a_WARN_with_a_reason_and_no_full_key(
        self,
        resolving_app: FastAPI,
        session: Session,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """`cache_unavailable` with a machine-readable reason — prefix only.

        The gateway is the single place holding both a key and a telemetry call,
        so the assertion is that nothing longer than a PREFIX reached the log
        line: a full key carries `cognito_sub` and `user_id`.
        """
        import logging

        from src.shared.http.cache_dependencies import get_cache_gateway

        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=_NOOP_METRICS
        )
        seed(session, order_id="ord_delbypass0000002")

        with (
            caplog.at_level(logging.WARNING, logger="src.shared.cache.gateway"),
            TestClient(resolving_app) as client,
        ):
            client.request(
                "DELETE",
                PATH,
                json=cascade_body(SUB_A, USER_A),
                headers=internal_headers(),
            )

        warnings = [
            record
            for record in caplog.records
            if getattr(record, "app_event", None) == "cache_unavailable"
        ]
        assert warnings
        assert all(
            getattr(record, "reason", None) == "redis_unavailable"
            for record in warnings
        )
        prefixes = {getattr(record, "cache_key_prefix", None) for record in warnings}
        assert prefixes == {"tracking:index:v1", "identity:sub-to-user:v1"}
        # Neither identity may appear anywhere on those lines.
        for record in warnings:
            rendered = str(vars(record))
            assert SUB_A not in rendered
            assert USER_A not in rendered


class TestCacheDisabled:
    """`CACHE_ENABLED=false` must keep the cascade working."""

    def test_the_cascade_succeeds_with_the_cache_off(
        self, resolving_app: FastAPI, session: Session
    ) -> None:
        from src.shared.config.settings import Settings, get_settings
        from tests.conftest import TEST_CARRIER_API_KEY

        def disabled() -> Settings:
            return Settings(
                database_writer_url="mysql+pymysql://unused/unused",
                database_reader_url="mysql+pymysql://unused/unused",
                grpc_api_key=TEST_GRPC_API_KEY,
                tracking_carrier_api_key=TEST_CARRIER_API_KEY,
                cache_enabled=False,
            )

        resolving_app.dependency_overrides[get_settings] = disabled
        seed(session, order_id="ord_deloff00000000001")

        with TestClient(resolving_app) as client:
            response = client.request(
                "DELETE",
                PATH,
                json=cascade_body(SUB_A, USER_A),
                headers=internal_headers(),
            )

        assert response.status_code == 200
        assert response.json() == {"deleted": 1}

    def test_no_eviction_is_scheduled_when_the_cache_is_off(
        self,
        resolving_app: FastAPI,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The `cache_enabled` guard, asserted rather than assumed.

        With the switch off the gateway bound is still the fixture's real one
        (the override table does not change), so an unguarded `add_task` would
        happily evict. Pre-populating a key and finding it intact is what
        distinguishes "guarded" from "the null object happened to no-op".
        """
        from src.shared.config.settings import Settings, get_settings
        from tests.conftest import TEST_CARRIER_API_KEY

        def disabled() -> Settings:
            return Settings(
                database_writer_url="mysql+pymysql://unused/unused",
                database_reader_url="mysql+pymysql://unused/unused",
                grpc_api_key=TEST_GRPC_API_KEY,
                tracking_carrier_api_key=TEST_CARRIER_API_KEY,
                cache_enabled=False,
            )

        resolving_app.dependency_overrides[get_settings] = disabled
        seed(session, order_id="ord_deloff00000000002")
        redis_double.sadd(index_key(), single_key("ord_deloff00000000002"))
        redis_double.set(single_key("ord_deloff00000000002"), '{"leftover": true}')

        with TestClient(resolving_app) as client:
            response = client.request(
                "DELETE",
                PATH,
                json=cascade_body(SUB_A, USER_A),
                headers=internal_headers(),
            )

        assert response.status_code == 200
        assert redis_double.exists(single_key("ord_deloff00000000002"))
