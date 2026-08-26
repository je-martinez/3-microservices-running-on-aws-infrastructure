"""`PUT /v1/trackings/{order_id}/status` — the carrier webhook (JE-94).

Real app, real MySQL. Three things are being verified, in descending order of how
easy they are to get wrong:

1. **The endpoint does not depend on `x-user-id`.** Its gateway route has no
   Cognito authorizer, so no such header exists on a real request. A handler that
   reused the reads' ownership filter would 404 every carrier call — implemented
   and permanently broken. `TestNoUserIdentity` sends NO identity header at all
   (and, separately, a WRONG one) and requires success either way.
2. **The carrier key is a separate credential.** Wrong or missing → 401, and the
   internal gRPC key does not work here.
3. **The state machine is enforced**, each guard reporting its own machine-readable
   `reason`, and a rejected update leaves the row untouched.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.features.tracking.domain.models import Tracking
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import (
    TrackingStatus,
    TransitionRejectionReason,
)
from src.shared.audit.audit_actor import AuditActor
from tests.conftest import TEST_CARRIER_API_KEY, TEST_GRPC_API_KEY

pytestmark = pytest.mark.integration

USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"
USER_B = "usr_bbbbbbbbbbbbbbbbbbbbb"


def seed(
    session: Session,
    *,
    order_id: str,
    user_id: str = USER_A,
    status: TrackingStatus = TrackingStatus.PLACED,
) -> str:
    """Create a committed tracking at `status` and return its id."""
    tracking = TrackingRepository(session).create(
        order_id=order_id,
        user_id=user_id,
        status=status,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def carrier() -> dict[str, str]:
    """The carrier's credential header."""
    return {"x-api-key": TEST_CARRIER_API_KEY}


def put(
    client: TestClient,
    order_id: str,
    status: str,
    *,
    headers: dict[str, str] | None = None,
):
    return client.put(
        f"/v1/trackings/{order_id}/status",
        json={"status": status},
        headers=carrier() if headers is None else headers,
    )


def reload(session: Session, order_id: str) -> Tracking:
    """Re-read the row from MySQL, bypassing anything cached in this session."""
    session.expire_all()
    found = TrackingRepository(session).get_by_order_id(order_id)
    assert found is not None
    return found


class TestCarrierAuth:
    def test_valid_key_succeeds(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_auth10000000000001")
        assert put(
            client, "ord_auth10000000000001", TrackingStatus.PROCESSING
        ).status_code == 200

    def test_missing_key_is_401(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_auth10000000000002")
        response = put(
            client, "ord_auth10000000000002", TrackingStatus.PROCESSING, headers={}
        )
        assert response.status_code == 401

    def test_wrong_key_is_401(
        self, client: TestClient, session: Session
    ) -> None:
        """401, not 403: a bad key identifies nobody, so there is no principal to
        forbid — and it keeps "wrong" indistinguishable from "absent"."""
        seed(session, order_id="ord_auth10000000000003")
        response = put(
            client,
            "ord_auth10000000000003",
            TrackingStatus.PROCESSING,
            headers={"x-api-key": "not-the-carrier-key"},
        )
        assert response.status_code == 401
        assert response.status_code != 403

    def test_the_internal_grpc_key_does_not_work_here(
        self, client: TestClient, session: Session
    ) -> None:
        """Two keys, two trust domains. The app fixture configures the internal
        gRPC key and the carrier key as two different literals; presenting the
        internal one here must be rejected exactly like any other wrong value."""
        seed(session, order_id="ord_auth10000000000004")
        response = put(
            client,
            "ord_auth10000000000004",
            TrackingStatus.PROCESSING,
            headers={"x-api-key": TEST_GRPC_API_KEY},
        )
        assert response.status_code == 401

    def test_a_rejected_call_writes_nothing(
        self, client: TestClient, session: Session
    ) -> None:
        """Auth runs before the handler, so the row must be untouched."""
        seed(session, order_id="ord_auth10000000000005")
        put(
            client,
            "ord_auth10000000000005",
            TrackingStatus.DELIVERED,
            headers={"x-api-key": "wrong"},
        )
        tracking = reload(session, "ord_auth10000000000005")
        assert tracking.status == TrackingStatus.PLACED
        assert len(tracking.history) == 1

    def test_the_key_is_never_echoed_back(
        self, client: TestClient, session: Session
    ) -> None:
        """A rotatable secret must not reach a low-trust sink — including an error
        body a caller could be tricked into pasting somewhere."""
        seed(session, order_id="ord_auth10000000000006")
        response = put(
            client,
            "ord_auth10000000000006",
            TrackingStatus.PROCESSING,
            headers={"x-api-key": "guessed-key-abc123"},
        )
        assert "guessed-key-abc123" not in response.text
        assert TEST_CARRIER_API_KEY not in response.text


class TestNoUserIdentity:
    """The endpoint must work with NO `x-user-id`, because there never is one.

    This is the design's explicit warning ("An implementer who assumes `x-user-id`
    is present here will write broken code"), so it gets its own class.
    """

    def test_succeeds_with_no_identity_header_at_all(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_noid00000000000001", user_id=USER_A)

        # Only the carrier key — deliberately no x-user-id, matching a real
        # request through the `auth = false` gateway route.
        response = put(
            client, "ord_noid00000000000001", TrackingStatus.PROCESSING
        )

        assert response.status_code == 200
        assert response.json()["status"] == TrackingStatus.PROCESSING

    def test_is_not_scoped_by_any_user(
        self, client: TestClient, session: Session
    ) -> None:
        """A stray `x-user-id` naming a DIFFERENT user must not scope the lookup.

        If the handler ever started filtering by it, this would 404 — the tracking
        belongs to user A. It must be ignored entirely: the endpoint identifies the
        tracking by `order_id` alone.
        """
        seed(session, order_id="ord_noid00000000000002", user_id=USER_A)

        response = client.put(
            "/v1/trackings/ord_noid00000000000002/status",
            json={"status": TrackingStatus.PROCESSING},
            headers={**carrier(), "x-user-id": USER_B},
        )

        assert response.status_code == 200

    def test_the_response_still_reports_the_owning_user(
        self, client: TestClient, session: Session
    ) -> None:
        """Unscoped lookup, but the row's own `user_id` is unchanged — the carrier
        does not become the owner by updating it."""
        seed(session, order_id="ord_noid00000000000003", user_id=USER_A)
        body = put(
            client, "ord_noid00000000000003", TrackingStatus.PROCESSING
        ).json()
        assert body["user_id"] == USER_A


class TestSuccessfulUpdate:
    def test_persists_the_new_status(
        self, client: TestClient, session: Session
    ) -> None:
        """Asserted against the DATABASE, not the response — a handler that only
        rendered the new status would pass a response-only check."""
        seed(session, order_id="ord_ok0000000000000001")
        put(client, "ord_ok0000000000000001", TrackingStatus.PROCESSING)
        assert reload(session, "ord_ok0000000000000001").status == (
            TrackingStatus.PROCESSING
        )

    def test_appends_a_history_row(
        self, client: TestClient, session: Session
    ) -> None:
        """The transition log is the point of the endpoint: the tracking's current
        status is derivable, the sequence of transitions is not."""
        seed(session, order_id="ord_ok0000000000000002")
        put(client, "ord_ok0000000000000002", TrackingStatus.PROCESSING)

        history = TrackingRepository(session).get_history(
            reload(session, "ord_ok0000000000000002").id
        )
        assert [entry.status for entry in history] == [
            TrackingStatus.PLACED,
            TrackingStatus.PROCESSING,
        ]

    def test_returns_the_updated_tracking_with_its_history(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_ok0000000000000003")
        body = put(
            client, "ord_ok0000000000000003", TrackingStatus.PROCESSING
        ).json()

        assert body["status"] == TrackingStatus.PROCESSING
        assert [entry["status"] for entry in body["history"]] == [
            TrackingStatus.PLACED,
            TrackingStatus.PROCESSING,
        ]

    def test_stamps_the_carrier_audit_actor(
        self, client: TestClient, session: Session
    ) -> None:
        """`updated_by` records WHAT produced the write — there is no user id to
        stamp on this path, which is exactly why the actor is semantic."""
        seed(session, order_id="ord_ok0000000000000004")
        put(client, "ord_ok0000000000000004", TrackingStatus.PROCESSING)
        assert reload(session, "ord_ok0000000000000004").updated_by == (
            AuditActor.CARRIER_STATUS_UPDATE
        )

    def test_can_walk_the_whole_progression(
        self, client: TestClient, session: Session
    ) -> None:
        """Five statuses, five history rows — the same total a completed TestMode
        run leaves behind."""
        seed(session, order_id="ord_ok0000000000000005")
        for status in (
            TrackingStatus.PROCESSING,
            TrackingStatus.SHIPPED,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            assert put(client, "ord_ok0000000000000005", status).status_code == 200

        tracking = reload(session, "ord_ok0000000000000005")
        assert tracking.status == TrackingStatus.DELIVERED
        assert len(tracking.history) == 5

    def test_can_skip_a_status_forward(
        self, client: TestClient, session: Session
    ) -> None:
        """The guard is "strictly forward", not "exactly one step" — a carrier that
        misses a scan still reports the status it actually observed."""
        seed(session, order_id="ord_ok0000000000000006")
        assert put(
            client, "ord_ok0000000000000006", TrackingStatus.DELIVERED
        ).status_code == 200


class TestRejectedTransitions:
    """Each guard, with its own machine-readable reason."""

    def test_backward_transition_is_400_with_its_reason(
        self, client: TestClient, session: Session
    ) -> None:
        seed(
            session,
            order_id="ord_bad00000000000001",
            status=TrackingStatus.OUT_FOR_DELIVERY,
        )
        response = put(client, "ord_bad00000000000001", TrackingStatus.PLACED)

        assert response.status_code == 400
        assert response.json()["reason"] == (
            TransitionRejectionReason.BACKWARD_TRANSITION
        )

    def test_same_status_is_400_not_strictly_forward(
        self, client: TestClient, session: Session
    ) -> None:
        """Distinct from a backward move: equal is not forward, and the two report
        different reasons so a caller can tell a replayed webhook from a bug."""
        seed(
            session,
            order_id="ord_bad00000000000002",
            status=TrackingStatus.PROCESSING,
        )
        response = put(client, "ord_bad00000000000002", TrackingStatus.PROCESSING)

        assert response.status_code == 400
        assert response.json()["reason"] == (
            TransitionRejectionReason.NOT_STRICTLY_FORWARD
        )

    def test_terminal_tracking_rejects_any_update(
        self, client: TestClient, session: Session
    ) -> None:
        """DELIVERED is terminal — ANY update against it is rejected, and the
        reason is `already_delivered` whatever was requested."""
        seed(
            session,
            order_id="ord_bad00000000000003",
            status=TrackingStatus.DELIVERED,
        )
        response = put(client, "ord_bad00000000000003", TrackingStatus.DELIVERED)

        assert response.status_code == 400
        assert response.json()["reason"] == (
            TransitionRejectionReason.ALREADY_DELIVERED
        )

    def test_terminal_beats_backward_when_both_apply(
        self, client: TestClient, session: Session
    ) -> None:
        """`DELIVERED -> PLACED` violates two guards; terminality is the more
        specific fact about the tracking, so it is the reported one."""
        seed(
            session,
            order_id="ord_bad00000000000004",
            status=TrackingStatus.DELIVERED,
        )
        response = put(client, "ord_bad00000000000004", TrackingStatus.PLACED)

        assert response.json()["reason"] == (
            TransitionRejectionReason.ALREADY_DELIVERED
        )

    def test_a_rejected_transition_writes_nothing(
        self, client: TestClient, session: Session
    ) -> None:
        """The guard runs before the write, so neither the status nor the history
        moves. A partially-applied rejection would corrupt the immutable log."""
        seed(
            session,
            order_id="ord_bad00000000000005",
            status=TrackingStatus.DELIVERED,
        )
        put(client, "ord_bad00000000000005", TrackingStatus.PLACED)

        tracking = reload(session, "ord_bad00000000000005")
        assert tracking.status == TrackingStatus.DELIVERED
        assert len(tracking.history) == 1

    def test_unknown_status_value_is_400(
        self, client: TestClient, session: Session
    ) -> None:
        """Not one of the five. 400 with a reason, not a 422 — the four rejection
        cases share one vocabulary so a carrier handles one shape."""
        seed(session, order_id="ord_bad00000000000006")
        response = put(client, "ord_bad00000000000006", "LOST_IN_SPACE")

        assert response.status_code == 400
        assert response.json()["reason"] == "invalid_status"

    def test_status_matching_is_case_sensitive(
        self, client: TestClient, session: Session
    ) -> None:
        """The five values are a fixed contract, matching the stored column
        exactly, not free-form input."""
        seed(session, order_id="ord_bad00000000000007")
        assert put(
            client, "ord_bad00000000000007", "processing"
        ).status_code == 400

    def test_the_400_carries_both_a_detail_and_a_flat_reason(
        self, client: TestClient, session: Session
    ) -> None:
        """`reason` must be TOP-LEVEL. FastAPI's default HTTPException rendering
        would nest it under `detail`, which is the bug this asserts against."""
        seed(
            session,
            order_id="ord_bad00000000000008",
            status=TrackingStatus.DELIVERED,
        )
        body = put(client, "ord_bad00000000000008", TrackingStatus.PLACED).json()

        assert set(body) == {"detail", "reason"}
        assert isinstance(body["detail"], str)


class TestNotFound:
    def test_unknown_order_id_is_404(self, client: TestClient) -> None:
        response = put(
            client, "ord_missing00000000001", TrackingStatus.PROCESSING
        )
        assert response.status_code == 404

    def test_404_requires_a_valid_key_first(self, client: TestClient) -> None:
        """An unauthenticated probe for a non-existent order gets 401, not 404 —
        the endpoint tells an unauthenticated caller nothing about what exists."""
        response = put(
            client, "ord_missing00000000002", TrackingStatus.PROCESSING, headers={}
        )
        assert response.status_code == 401

    def test_a_soft_deleted_tracking_is_404(
        self, client: TestClient, session: Session
    ) -> None:
        """Soft-deleted rows are invisible to every read in the repository, so the
        carrier cannot resurrect one by updating it."""
        from datetime import UTC, datetime

        seed(session, order_id="ord_missing00000000003")
        tracking = reload(session, "ord_missing00000000003")
        tracking.deleted_at = datetime.now(UTC).replace(tzinfo=None, microsecond=0)
        session.commit()

        assert put(
            client, "ord_missing00000000003", TrackingStatus.PROCESSING
        ).status_code == 404


class TestRequestValidation:
    def test_missing_status_field_is_422(
        self, client: TestClient, session: Session
    ) -> None:
        """Pydantic rejects a body without `status` before the handler runs."""
        seed(session, order_id="ord_req00000000000001")
        response = client.put(
            "/v1/trackings/ord_req00000000000001/status",
            json={},
            headers=carrier(),
        )
        assert response.status_code == 422

    def test_body_validation_does_not_run_before_auth(
        self, client: TestClient
    ) -> None:
        """A malformed body from an unauthenticated caller is still 401 — the
        router-level dependency gates the endpoint, so an anonymous caller cannot
        probe the request schema."""
        response = client.put(
            "/v1/trackings/ord_req00000000000002/status",
            json={},
            headers={},
        )
        assert response.status_code == 401
