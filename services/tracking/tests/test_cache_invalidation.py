"""The carrier webhook clears the cache — after its transaction commits.

The single-tracking key is easy: the webhook knows the `order_id` and reads the
owner's sub off the row it just wrote. The LIST keys are not: each embeds a
sha256 of an arbitrary caller-supplied id list, which cannot be reconstructed
from anything the webhook holds. Those are cleared through the per-user index.
"""

from collections.abc import Iterator

import fakeredis
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.shared.http.caller import get_users_client
from tests.conftest import TEST_CARRIER_API_KEY
from tests.test_cached_reads import ExplodingRedis, StubResolver
from tests.test_rest_reads import SUB_A, USER_A, as_user, seed

pytestmark = pytest.mark.integration


def carrier_headers() -> dict[str, str]:
    return {"x-api-key": TEST_CARRIER_API_KEY}


@pytest.fixture
def resolving_app(app: FastAPI) -> FastAPI:
    app.dependency_overrides[get_users_client] = lambda: StubResolver({SUB_A: USER_A})
    return app


@pytest.fixture
def resolving_client(resolving_app: FastAPI) -> Iterator[TestClient]:
    with TestClient(resolving_app) as test_client:
        yield test_client


class TestSingleKeyInvalidation:
    def test_a_status_update_evicts_the_owner_s_single_read(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        order_id = "ord_inval00000000001"
        seed(session, order_id=order_id)
        url = f"/v1/trackings/{order_id}"

        resolving_client.get(url, headers=as_user(SUB_A))
        assert (
            resolving_client.get(url, headers=as_user(SUB_A)).headers["x-cache"]
            == "HIT"
        )

        update = resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PROCESSING"},
            headers=carrier_headers(),
        )
        assert update.status_code == 200

        after = resolving_client.get(url, headers=as_user(SUB_A))
        assert after.headers["x-cache"] == "MISS"
        assert after.json()["status"] == "PROCESSING"

    def test_the_eviction_happens_AFTER_the_commit(
        self,
        resolving_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """The ordering the design turns on, asserted from the outside.

        A repopulation racing an uncommitted write is not reproducible in a
        single-threaded TestClient, but its precondition is: the key must be
        gone once the response has been returned, and the row it would be
        rebuilt from must already carry the new status. Both hold only if the
        eviction ran after `write_session`'s commit.
        """
        order_id = "ord_inval00000000004"
        seed(session, order_id=order_id)
        key = f"tracking:order:v1:{SUB_A}:{USER_A}:{order_id}"

        resolving_client.get(f"/v1/trackings/{order_id}", headers=as_user(SUB_A))
        assert redis_double.exists(key)

        resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PROCESSING"},
            headers=carrier_headers(),
        )

        assert not redis_double.exists(key)
        rebuilt = resolving_client.get(
            f"/v1/trackings/{order_id}", headers=as_user(SUB_A)
        )
        assert rebuilt.json()["status"] == "PROCESSING"

    def test_a_REJECTED_update_leaves_the_cache_alone(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """Nothing was written, so nothing is stale. The HIT must survive.

        This is the assertion that catches invalidating from the wrong place:
        an eviction wired before the guards would fire on a 400 too, quietly
        costing a hit rate for a write that never happened.
        """
        order_id = "ord_inval00000000002"
        seed(session, order_id=order_id)
        url = f"/v1/trackings/{order_id}"

        resolving_client.get(url, headers=as_user(SUB_A))
        rejected = resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PLACED"},
            headers=carrier_headers(),
        )
        assert rejected.status_code == 400

        assert (
            resolving_client.get(url, headers=as_user(SUB_A)).headers["x-cache"]
            == "HIT"
        )

    def test_a_404_update_invalidates_nothing(
        self, resolving_client: TestClient
    ) -> None:
        missing = resolving_client.put(
            "/v1/trackings/ord_nosuchtracking001/status",
            json={"status": "SHIPPED"},
            headers=carrier_headers(),
        )
        assert missing.status_code == 404


class TestListKeyInvalidation:
    def test_a_status_update_evicts_the_owner_s_LIST_keys(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """The keys the webhook cannot reconstruct, cleared via the index."""
        order_id = "ord_invallist0000001"
        other = "ord_invallist0000002"
        seed(session, order_id=order_id)
        seed(session, order_id=other)

        one = f"/v1/trackings?order_ids={order_id}"
        both = f"/v1/trackings?order_ids={order_id},{other}"
        resolving_client.get(one, headers=as_user(SUB_A))
        resolving_client.get(both, headers=as_user(SUB_A))
        assert (
            resolving_client.get(both, headers=as_user(SUB_A)).headers["x-cache"]
            == "HIT"
        )

        resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PROCESSING"},
            headers=carrier_headers(),
        )

        # BOTH list keys go, not only the one naming the updated order: the
        # index holds keys, not the ids inside them, so the eviction is
        # per-user rather than per-order. Deliberately coarse — a 60s TTL
        # bounds the cost, and reconstructing which hashes contained the id
        # would need exactly the scan this index exists to avoid.
        assert (
            resolving_client.get(one, headers=as_user(SUB_A)).headers["x-cache"]
            == "MISS"
        )
        assert (
            resolving_client.get(both, headers=as_user(SUB_A)).headers["x-cache"]
            == "MISS"
        )

    def test_the_index_itself_is_cleared_too(
        self,
        resolving_client: TestClient,
        session: Session,
        redis_double: fakeredis.FakeRedis,
    ) -> None:
        """An index left holding dead keys would grow without bound."""
        order_id = "ord_invallist0000003"
        seed(session, order_id=order_id)
        resolving_client.get(
            f"/v1/trackings?order_ids={order_id}", headers=as_user(SUB_A)
        )
        index = f"tracking:index:v1:{SUB_A}:{USER_A}"
        assert redis_double.smembers(index)

        resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PROCESSING"},
            headers=carrier_headers(),
        )
        assert redis_double.smembers(index) == set()


class TestNullCognitoSub:
    """A tracking with no owner sub cannot have a per-user key to evict."""

    def test_the_update_succeeds_and_nothing_crashes(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        """`cognito_sub` is NULLABLE (domain/models.py).

        A row created before the column existed, or created with `""` (which
        `create` normalizes to NULL), has no sub. Such a row is UNREACHABLE
        over the user-scoped reads — the ownership filter compares against a
        sub and NULL matches nobody — so it can have no cached entry, so
        there is nothing to invalidate. The update must still succeed.
        """
        order_id = "ord_nullsub000000001"
        seed(session, order_id=order_id, cognito_sub=None)

        response = resolving_client.put(
            f"/v1/trackings/{order_id}/status",
            json={"status": "PROCESSING"},
            headers=carrier_headers(),
        )
        assert response.status_code == 200
        assert response.json()["status"] == "PROCESSING"

    def test_that_row_is_unreadable_so_it_was_never_cached(
        self, resolving_client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_nullsub000000002", cognito_sub=None)
        response = resolving_client.get(
            "/v1/trackings/ord_nullsub000000002", headers=as_user(SUB_A)
        )
        assert response.status_code == 404


class TestFailOpen:
    def test_a_dead_redis_does_not_fail_the_status_update(
        self, resolving_app: FastAPI, session: Session
    ) -> None:
        """The write is the important half; the eviction is best-effort."""
        from src.shared.cache.gateway import CacheGateway
        from src.shared.http.cache_dependencies import get_cache_gateway
        from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher

        resolving_app.dependency_overrides[get_cache_gateway] = lambda: CacheGateway(
            client=ExplodingRedis(), metrics=NoopMetricsPublisher()
        )
        seed(session, order_id="ord_invalbypass00001")
        with TestClient(resolving_app) as client:
            response = client.put(
                "/v1/trackings/ord_invalbypass00001/status",
                json={"status": "PROCESSING"},
                headers=carrier_headers(),
            )
        assert response.status_code == 200
        assert response.json()["status"] == "PROCESSING"
