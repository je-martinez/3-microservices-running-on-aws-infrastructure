"""gRPC surface tests: a REAL server on a REAL socket, over a REAL MySQL (JE-90/91).

Deliberately end-to-end within the service. Calling `TrackingServicer` methods
directly would be easier and would verify nothing that matters here: it skips the
interceptor (so auth is untested), skips protobuf serialization (so a field mapped
to the wrong name still "passes"), and skips status-code mapping (so `context.abort`
never actually becomes a NOT_FOUND on the wire). Everything below goes through a
channel.

The database is real for the reason recorded in `conftest.py` and the repo's
standing lesson: a mocked session cannot catch a JSON column, a composite PK, a
unique constraint, or an ORDER BY that MySQL resolves differently than the mock.
When no MySQL is reachable the whole module SKIPS with an explicit message — it
never falls back.
"""

from __future__ import annotations

from datetime import datetime

import grpc
import pytest
from sqlalchemy.orm import Session

from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.db.nano_id import TRACKING_PREFIX
from src.shared.grpc.generated import tracking_pb2, tracking_pb2_grpc
from tests.conftest import TEST_API_KEY

pytestmark = pytest.mark.integration

ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "line2": "Apt 2",
    "city": "Springfield",
    "state": "OR",
    "country": "US",
    "postal_code": "97477",
}

USER_ID = "usr_aaaaaaaaaaaaaaaaaaaaa"


def auth() -> list[tuple[str, str]]:
    """Metadata carrying the valid key — every successful call needs it."""
    return [("x-api-key", TEST_API_KEY)]


@pytest.fixture
def stub(grpc_channel: grpc.Channel) -> tracking_pb2_grpc.TrackingStub:
    return tracking_pb2_grpc.TrackingStub(grpc_channel)


def seed(
    session: Session,
    *,
    order_id: str,
    user_id: str = USER_ID,
    statuses: tuple[TrackingStatus, ...] = (),
    now: datetime | None = None,
) -> str:
    """Insert a tracking (plus optional extra transitions) directly, returning its id.

    Seeding through the repository rather than through `CreateTracking` keeps the
    read tests independent of the write RPC: a bug in creation should fail the
    creation tests, not every read test as well.
    """
    repository = TrackingRepository(session)
    tracking = repository.create(
        order_id=order_id, user_id=user_id, shipping_address=dict(ADDRESS), now=now
    )
    for status in statuses:
        repository.update_status(
            tracking=tracking,
            status=status,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
            now=now,
        )
    session.commit()
    return tracking.id


class TestApiKeyGate:
    """The interceptor, observed through the wire — it guards ALL THREE RPCs."""

    def test_create_without_a_key_is_unauthenticated(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.CreateTracking(
                tracking_pb2.CreateTrackingRequest(
                    order_id="ord_noauth00000000000001", user_id=USER_ID
                )
            )
        assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED

    def test_create_with_a_wrong_key_is_unauthenticated(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.CreateTracking(
                tracking_pb2.CreateTrackingRequest(
                    order_id="ord_badauth0000000000001", user_id=USER_ID
                ),
                metadata=[("x-api-key", "definitely-not-the-key")],
            )
        assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED

    def test_single_read_without_a_key_is_unauthenticated(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.GetTrackingByOrderId(
                tracking_pb2.GetTrackingByOrderIdRequest(order_id="ord_whatever")
            )
        assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED

    def test_batch_read_without_a_key_is_unauthenticated(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.GetTrackingsByOrderIds(
                tracking_pb2.GetTrackingsByOrderIdsRequest(order_ids=["ord_whatever"])
            )
        assert exc.value.code() == grpc.StatusCode.UNAUTHENTICATED

    def test_a_rejected_call_never_reaches_the_database(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """Auth is a gate, not a filter: nothing is written on the way to a 401."""
        with pytest.raises(grpc.RpcError):
            stub.CreateTracking(
                tracking_pb2.CreateTrackingRequest(
                    order_id="ord_noauth00000000000002", user_id=USER_ID
                )
            )
        assert (
            TrackingRepository(session).get_by_order_id("ord_noauth00000000000002")
            is None
        )

    def test_the_valid_key_is_accepted(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_okauth000000000000001", user_id=USER_ID
            ),
            metadata=auth(),
        )
        assert response.tracking.order_id == "ord_okauth000000000000001"

    def test_the_key_does_not_leak_into_the_error_details(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """A rejection must not echo back the expected (or provided) secret."""
        with pytest.raises(grpc.RpcError) as exc:
            stub.GetTrackingByOrderId(
                tracking_pb2.GetTrackingByOrderIdRequest(order_id="ord_x"),
                metadata=[("x-api-key", "guessed-key")],
            )
        details = exc.value.details() or ""
        assert TEST_API_KEY not in details
        assert "guessed-key" not in details


class TestCreateTracking:
    """JE-90 — the create RPC's persistence and response."""

    def test_persists_a_tracking_at_shipped(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpccreate00000001",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(**ADDRESS),
            ),
            metadata=auth(),
        )
        assert response.tracking.status == TrackingStatus.SHIPPED
        assert response.tracking.id.startswith(TRACKING_PREFIX)

        stored = TrackingRepository(session).get_by_order_id("ord_grpccreate00000001")
        assert stored is not None
        assert stored.id == response.tracking.id
        assert stored.status == TrackingStatus.SHIPPED

    def test_writes_the_first_history_row_in_the_same_transaction(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """A tracking whose own creation left no trace in the log would be a bug."""
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpccreate00000002", user_id=USER_ID
            ),
            metadata=auth(),
        )
        history = TrackingRepository(session).get_history(response.tracking.id)
        assert [h.status for h in history] == [TrackingStatus.SHIPPED]

    def test_the_response_carries_the_full_record(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpccreate00000003",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(**ADDRESS),
            ),
            metadata=auth(),
        )
        record = response.tracking
        assert record.order_id == "ord_grpccreate00000003"
        assert record.user_id == USER_ID
        # ISO-8601 with an explicit Z, so the .NET client reads it as UTC.
        assert record.datetime.endswith("Z")
        assert datetime.fromisoformat(record.datetime.removesuffix("Z"))

    def test_missing_order_id_is_invalid_argument(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """proto3 gives an omitted string `""`; storing that as an id would be a
        row matching nothing, so it is rejected at the edge."""
        with pytest.raises(grpc.RpcError) as exc:
            stub.CreateTracking(
                tracking_pb2.CreateTrackingRequest(user_id=USER_ID), metadata=auth()
            )
        assert exc.value.code() == grpc.StatusCode.INVALID_ARGUMENT

    def test_missing_user_id_is_invalid_argument(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.CreateTracking(
                tracking_pb2.CreateTrackingRequest(order_id="ord_nouser0000000000001"),
                metadata=auth(),
            )
        assert exc.value.code() == grpc.StatusCode.INVALID_ARGUMENT

    def test_a_duplicate_order_id_fails_and_leaves_one_row(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """The UNIQUE constraint is the guarantee — the second call must not win."""
        request = tracking_pb2.CreateTrackingRequest(
            order_id="ord_grpcdup00000000001", user_id=USER_ID
        )
        stub.CreateTracking(request, metadata=auth())
        with pytest.raises(grpc.RpcError):
            stub.CreateTracking(request, metadata=auth())

        found = TrackingRepository(session).get_by_order_ids(
            ["ord_grpcdup00000000001"]
        )
        assert len(found) == 1


class TestCreateTrackingAddressMapping:
    """The Address proto -> JSON column mapping, through the wire and MySQL."""

    def test_a_full_address_round_trips_through_the_json_column(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcaddr0000000001",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(**ADDRESS),
            ),
            metadata=auth(),
        )
        stored = TrackingRepository(session).get_by_order_id("ord_grpcaddr0000000001")
        assert stored is not None
        assert stored.shipping_address == ADDRESS

    def test_an_empty_field_is_omitted_from_the_stored_json(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """proto3 sends `""` for an absent key; we store absence AS absence."""
        partial = dict(ADDRESS) | {"line2": "", "state": ""}
        stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcaddr0000000002",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(**partial),
            ),
            metadata=auth(),
        )
        stored = TrackingRepository(session).get_by_order_id("ord_grpcaddr0000000002")
        assert stored is not None
        assert stored.shipping_address is not None
        assert "line2" not in stored.shipping_address
        assert "state" not in stored.shipping_address
        assert stored.shipping_address["city"] == ADDRESS["city"]

    def test_an_absent_address_message_stores_null(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcaddr0000000003", user_id=USER_ID
            ),
            metadata=auth(),
        )
        stored = TrackingRepository(session).get_by_order_id("ord_grpcaddr0000000003")
        assert stored is not None
        assert stored.shipping_address is None

    def test_an_all_empty_address_message_also_stores_null(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """`{}` and NULL would be two encodings of one fact; we keep one."""
        stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcaddr0000000004",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(),
            ),
            metadata=auth(),
        )
        stored = TrackingRepository(session).get_by_order_id("ord_grpcaddr0000000004")
        assert stored is not None
        assert stored.shipping_address is None

    def test_the_response_returns_omitted_fields_as_empty_strings(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """What was dropped comes back as `""` — the value proto3 sent anyway."""
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcaddr0000000005",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(line1="742 Evergreen Terrace"),
            ),
            metadata=auth(),
        )
        assert response.tracking.shipping_address.line1 == "742 Evergreen Terrace"
        assert response.tracking.shipping_address.line2 == ""
        assert response.tracking.shipping_address.postal_code == ""


class TestCreateTrackingTestMode:
    """`test_mode` is accepted and recorded; the timer itself is Phase E."""

    @pytest.mark.parametrize("test_mode", [True, False])
    def test_the_flag_is_accepted_on_the_request(
        self, stub: tracking_pb2_grpc.TrackingStub, test_mode: bool
    ) -> None:
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id=f"ord_grpctm{int(test_mode)}00000000001",
                user_id=USER_ID,
                test_mode=test_mode,
            ),
            metadata=auth(),
        )
        assert response.tracking.status == TrackingStatus.SHIPPED

    def test_test_mode_does_not_progress_the_status_yet(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """Phase E owns the 10s progression; nothing here schedules anything.

        Asserted so that adding the timer later has to change a test that says what
        today's behaviour is, rather than silently satisfying an absent one.
        """
        response = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpctm000000000010",
                user_id=USER_ID,
                test_mode=True,
            ),
            metadata=auth(),
        )
        history = TrackingRepository(session).get_history(response.tracking.id)
        assert [h.status for h in history] == [TrackingStatus.SHIPPED]

    def test_the_flag_is_not_persisted_as_a_column(self, engine) -> None:
        """It describes the request, not the shipment — see CreateTrackingResult."""
        from sqlalchemy import inspect

        columns = {c["name"] for c in inspect(engine).get_columns("tracking")}
        assert "test_mode" not in columns

    def test_the_command_result_carries_the_flag_for_phase_e(
        self, session: Session
    ) -> None:
        """The hand-off point: Phase E reads the flag and the id from here."""
        from src.features.tracking.commands.create_tracking import (
            CreateTrackingCommand,
            create_tracking,
        )

        result = create_tracking(
            session,
            CreateTrackingCommand(
                order_id="ord_grpctm000000000011", user_id=USER_ID, test_mode=True
            ),
        )
        session.commit()
        assert result.test_mode is True
        assert result.tracking.id.startswith(TRACKING_PREFIX)


class TestGetTrackingByOrderId:
    """JE-91 — the single unscoped read."""

    def test_returns_the_tracking_with_its_history(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        tracking_id = seed(
            session,
            order_id="ord_grpcread0000000001",
            statuses=(TrackingStatus.ON_THE_WAY,),
        )
        response = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpcread0000000001"
            ),
            metadata=auth(),
        )
        assert response.tracking.tracking.id == tracking_id
        assert [h.status for h in response.tracking.history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
        ]

    def test_history_entries_carry_the_trackings_identity(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        tracking_id = seed(session, order_id="ord_grpcread0000000002")
        response = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpcread0000000002"
            ),
            metadata=auth(),
        )
        entry = response.tracking.history[0]
        assert entry.tracking_id == tracking_id
        assert entry.order_id == "ord_grpcread0000000002"
        assert entry.user_id == USER_ID
        assert entry.datetime.endswith("Z")

    def test_history_is_in_progression_order_not_alphabetical(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """DELIVERED sorts FIRST alphabetically; on the wire it must come last."""
        seed(
            session,
            order_id="ord_grpcread0000000003",
            statuses=(
                TrackingStatus.ON_THE_WAY,
                TrackingStatus.OUT_FOR_DELIVERY,
                TrackingStatus.DELIVERED,
            ),
        )
        response = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpcread0000000003"
            ),
            metadata=auth(),
        )
        assert [h.status for h in response.tracking.history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ]

    def test_history_order_holds_when_every_timestamp_is_identical(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """The regression Phase B found, re-checked at the transport boundary.

        With a bare `datetime` ORDER BY, MySQL falls back to primary-key order,
        which for `(tracking_id, status)` is alphabetical — DELIVERED first,
        SHIPPED last, exactly reversed. The tiebreaker in
        `TrackingHistory.ordering()` is what keeps this correct, and this asserts
        the gRPC response actually benefits from it.
        """
        frozen = datetime(2026, 7, 29, 12, 0, 0)
        seed(
            session,
            order_id="ord_grpctie000000000001",
            statuses=(
                TrackingStatus.ON_THE_WAY,
                TrackingStatus.OUT_FOR_DELIVERY,
                TrackingStatus.DELIVERED,
            ),
            now=frozen,
        )
        response = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpctie000000000001"
            ),
            metadata=auth(),
        )
        history = response.tracking.history
        assert {h.datetime for h in history} == {f"{frozen.isoformat()}Z"}
        assert [h.status for h in history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ]

    def test_an_unknown_order_id_is_not_found(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        with pytest.raises(grpc.RpcError) as exc:
            stub.GetTrackingByOrderId(
                tracking_pb2.GetTrackingByOrderIdRequest(
                    order_id="ord_grpcmissing0000001"
                ),
                metadata=auth(),
            )
        assert exc.value.code() == grpc.StatusCode.NOT_FOUND

    def test_the_read_is_unscoped_across_users(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """The contrast with Phase D's REST read: no ownership filter at all.

        Two trackings owned by two different users are BOTH readable by the same
        trusted gRPC caller. Over REST, each user would see only their own.
        """
        seed(session, order_id="ord_grpcunscoped00001", user_id="usr_one")
        seed(session, order_id="ord_grpcunscoped00002", user_id="usr_two")

        first = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpcunscoped00001"
            ),
            metadata=auth(),
        )
        second = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(
                order_id="ord_grpcunscoped00002"
            ),
            metadata=auth(),
        )
        assert first.tracking.tracking.user_id == "usr_one"
        assert second.tracking.tracking.user_id == "usr_two"

    def test_a_soft_deleted_tracking_is_not_found(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        seed(session, order_id="ord_grpcdel0000000001")
        tracking = TrackingRepository(session).get_by_order_id(
            "ord_grpcdel0000000001"
        )
        assert tracking is not None
        tracking.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        session.commit()

        with pytest.raises(grpc.RpcError) as exc:
            stub.GetTrackingByOrderId(
                tracking_pb2.GetTrackingByOrderIdRequest(
                    order_id="ord_grpcdel0000000001"
                ),
                metadata=auth(),
            )
        assert exc.value.code() == grpc.StatusCode.NOT_FOUND

    def test_create_and_read_report_the_same_timestamp(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """Regression: the create response must quote an instant MySQL kept.

        `sa.DateTime()` is `DATETIME` with fsp 0, and MySQL ROUNDS the fractional
        part away on write rather than truncating it. Rendering the create response
        off the in-memory entity, which still carried its microseconds, made the
        two RPCs report different times for one row — create said
        `...T04:03:46.965829Z`, the read said `...T04:03:47Z`. Caught only because
        this suite runs against real MySQL. Fixed by minting whole-second
        timestamps in the repository; see `_utcnow`.
        """
        created = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcts00000000001", user_id=USER_ID
            ),
            metadata=auth(),
        )
        read = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(order_id="ord_grpcts00000000001"),
            metadata=auth(),
        )
        assert created.tracking.datetime == read.tracking.tracking.datetime
        # And it carries no fractional part at all, so nothing can round it later.
        assert "." not in created.tracking.datetime

    def test_it_reads_back_what_create_wrote(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """The two RPCs must agree on the same row — including the address."""
        created = stub.CreateTracking(
            tracking_pb2.CreateTrackingRequest(
                order_id="ord_grpcrt00000000001",
                user_id=USER_ID,
                shipping_address=tracking_pb2.Address(**ADDRESS),
            ),
            metadata=auth(),
        )
        read = stub.GetTrackingByOrderId(
            tracking_pb2.GetTrackingByOrderIdRequest(order_id="ord_grpcrt00000000001"),
            metadata=auth(),
        )
        assert read.tracking.tracking == created.tracking


class TestGetTrackingsByOrderIds:
    """JE-91 — the batch unscoped read."""

    def test_returns_each_tracking_with_its_own_history(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        seed(session, order_id="ord_grpcbatch00000001")
        seed(
            session,
            order_id="ord_grpcbatch00000002",
            statuses=(TrackingStatus.ON_THE_WAY, TrackingStatus.OUT_FOR_DELIVERY),
        )

        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=["ord_grpcbatch00000001", "ord_grpcbatch00000002"]
            ),
            metadata=auth(),
        )
        by_order = {t.tracking.order_id: t for t in response.trackings}
        assert len(by_order) == 2
        assert [h.status for h in by_order["ord_grpcbatch00000001"].history] == [
            TrackingStatus.SHIPPED
        ]
        assert [h.status for h in by_order["ord_grpcbatch00000002"].history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
        ]

    def test_missing_ids_are_omitted_not_an_error(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """The .proto's response has no per-id error field, so omission is the
        only semantics it can express — and it matches the batch REST rule."""
        seed(session, order_id="ord_grpcbatch00000010")

        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=[
                    "ord_grpcbatch00000010",
                    "ord_grpcmissing0000010",
                    "ord_grpcmissing0000011",
                ]
            ),
            metadata=auth(),
        )
        assert [t.tracking.order_id for t in response.trackings] == [
            "ord_grpcbatch00000010"
        ]

    def test_all_ids_missing_returns_an_empty_ok_response(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        """"None of these exist" is a complete answer, not NOT_FOUND."""
        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=["ord_grpcmissing0000020", "ord_grpcmissing0000021"]
            ),
            metadata=auth(),
        )
        assert list(response.trackings) == []

    def test_an_empty_request_returns_an_empty_response(
        self, stub: tracking_pb2_grpc.TrackingStub
    ) -> None:
        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(order_ids=[]), metadata=auth()
        )
        assert list(response.trackings) == []

    def test_duplicate_ids_do_not_duplicate_the_result(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """`IN (x, x)` matches the row once — the caller gets one entry."""
        seed(session, order_id="ord_grpcbatch00000030")
        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=["ord_grpcbatch00000030", "ord_grpcbatch00000030"]
            ),
            metadata=auth(),
        )
        assert len(response.trackings) == 1

    def test_the_batch_read_is_unscoped_across_users(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        """Three owners, one trusted caller, three results."""
        seed(session, order_id="ord_grpcbatch00000040", user_id="usr_one")
        seed(session, order_id="ord_grpcbatch00000041", user_id="usr_two")
        seed(session, order_id="ord_grpcbatch00000042", user_id="usr_three")

        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=[
                    "ord_grpcbatch00000040",
                    "ord_grpcbatch00000041",
                    "ord_grpcbatch00000042",
                ]
            ),
            metadata=auth(),
        )
        assert {t.tracking.user_id for t in response.trackings} == {
            "usr_one",
            "usr_two",
            "usr_three",
        }

    def test_soft_deleted_trackings_are_omitted(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session
    ) -> None:
        seed(session, order_id="ord_grpcbatch00000050")
        seed(session, order_id="ord_grpcbatch00000051")
        deleted = TrackingRepository(session).get_by_order_id(
            "ord_grpcbatch00000051"
        )
        assert deleted is not None
        deleted.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        session.commit()

        response = stub.GetTrackingsByOrderIds(
            tracking_pb2.GetTrackingsByOrderIdsRequest(
                order_ids=["ord_grpcbatch00000050", "ord_grpcbatch00000051"]
            ),
            metadata=auth(),
        )
        assert [t.tracking.order_id for t in response.trackings] == [
            "ord_grpcbatch00000050"
        ]

    def test_history_is_not_loaded_per_tracking(
        self, stub: tracking_pb2_grpc.TrackingStub, session: Session, engine
    ) -> None:
        """The N+1 guard: history for the WHOLE batch costs one extra query.

        Counted by instrumenting the engine — `selectin` eager loading means the
        query count must not grow with the number of trackings asked for. A loop of
        single reads would make this 2N and is the obvious way to write it wrong.
        """
        from sqlalchemy import event

        for n in range(5):
            seed(session, order_id=f"ord_grpcn1000000000{n:03d}")

        statements: list[str] = []

        def record(conn, cursor, statement, parameters, context, executemany):
            statements.append(statement)

        event.listen(engine, "before_cursor_execute", record)
        try:
            response = stub.GetTrackingsByOrderIds(
                tracking_pb2.GetTrackingsByOrderIdsRequest(
                    order_ids=[f"ord_grpcn1000000000{n:03d}" for n in range(5)]
                ),
                metadata=auth(),
            )
        finally:
            event.remove(engine, "before_cursor_execute", record)

        assert len(response.trackings) == 5
        selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
        # One for the trackings, one selectin load for all their history rows.
        # Five trackings must NOT mean five history queries.
        assert len(selects) == 2, selects
        assert all(len(t.history) == 1 for t in response.trackings)
