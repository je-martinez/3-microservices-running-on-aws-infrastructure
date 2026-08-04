"""Repository + model tests against a REAL MySQL (JE-88).

Not mocks, and not SQLite. The things most likely to be wrong here — a JSON
column, a composite primary key, a unique constraint, VARCHAR widths against
25-char prefixed nano-IDs — are precisely the things a mocked session cannot
check and a different dialect can silently accept.
"""

from datetime import datetime, timedelta

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from src.features.tracking.domain.models import (
    E2E_SOURCE_TAG,
    Tracking,
    TrackingHistory,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor
from src.shared.db.nano_id import TRACKING_PREFIX, new_tracking_id

pytestmark = pytest.mark.integration

ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "line2": "",
    "city": "Springfield",
    "state": "OR",
    "country": "US",
    "postal_code": "97477",
}


@pytest.fixture
def repo(session: Session) -> TrackingRepository:
    return TrackingRepository(session)


# Distinguishes "caller said nothing" from "caller explicitly said None". Using
# None as the default made `address=None` silently fall back to ADDRESS, so the
# absent-address test asserted on a populated address and failed — a bug in the
# test, but one that would have hidden a real absent-address regression.
_DEFAULT = object()


def make_tracking(
    repo: TrackingRepository,
    *,
    order_id: str,
    user_id: str = "usr_aaaaaaaaaaaaaaaaaaaaa",
    cognito_sub: str | None | object = _DEFAULT,
    address: dict | None | object = _DEFAULT,
    tags: list[str] | None = None,
) -> Tracking:
    """Create a committed tracking.

    `cognito_sub` defaults to a value DERIVED from `user_id` rather than to a
    constant, so a test that sets only `user_id` still gets two distinct users with
    two distinct subs. A shared constant would make every "another user" test pass
    for the wrong reason — both users would carry the same ownership key.

    `tags` defaults to None -> `[]`: an ORDINARY tracking, not an E2E fixture. The
    default has to be the untagged one, or a test asserting that the cleanup spares
    untagged rows would be seeding the very thing it expects to survive.
    """
    tracking = repo.create(
        order_id=order_id,
        user_id=user_id,
        cognito_sub=(
            f"sub-{user_id}" if cognito_sub is _DEFAULT else cognito_sub  # type: ignore[arg-type]
        ),
        shipping_address=ADDRESS if address is _DEFAULT else address,  # type: ignore[arg-type]
        tags=tags,
    )
    repo.session.commit()
    return tracking


class TestSchema:
    """The physical schema, as MySQL actually created it."""

    def test_tables_exist(self, engine) -> None:
        tables = set(inspect(engine).get_table_names())
        assert {"tracking", "tracking_history"} <= tables

    def test_history_primary_key_is_the_composite_pair(self, engine) -> None:
        pk = inspect(engine).get_pk_constraint("tracking_history")
        assert pk["constrained_columns"] == ["tracking_id", "status"]

    def test_history_has_no_surrogate_id_column(self, engine) -> None:
        """The spec's table lists no `id`; the composite PK is the identity."""
        columns = {c["name"] for c in inspect(engine).get_columns("tracking_history")}
        assert "id" not in columns

    def test_history_has_no_shipping_address(self, engine) -> None:
        """Explicit in the spec: the address is fixed per tracking,
        not per transition."""
        columns = {c["name"] for c in inspect(engine).get_columns("tracking_history")}
        assert "shipping_address" not in columns

    def test_tracking_has_shipping_address_as_json(self, engine) -> None:
        column = next(
            c
            for c in inspect(engine).get_columns("tracking")
            if c["name"] == "shipping_address"
        )
        assert "json" in str(column["type"]).lower()

    @pytest.mark.parametrize("table", ["tracking", "tracking_history"])
    def test_cognito_sub_column_exists_on_both_tables(
        self, engine, table: str
    ) -> None:
        """The ownership key for the user-scoped reads, denormalized onto the
        history table alongside the `user_id`/`order_id` it already carries."""
        columns = {c["name"] for c in inspect(engine).get_columns(table)}
        assert "cognito_sub" in columns

    @pytest.mark.parametrize("table", ["tracking", "tracking_history"])
    def test_cognito_sub_is_nullable(self, engine, table: str) -> None:
        """The wire field is optional, so a row created by an older caller keeps
        NULL — invisible to the scoped reads rather than mis-attributed."""
        column = next(
            c
            for c in inspect(engine).get_columns(table)
            if c["name"] == "cognito_sub"
        )
        assert column["nullable"] is True

    def test_cognito_sub_is_wide_enough_for_orders_column(self, engine) -> None:
        """255, matching Orders' `order.cognito_sub`. The two MySQL services
        storing the same value under the same name must not disagree on width."""
        column = next(
            c
            for c in inspect(engine).get_columns("tracking")
            if c["name"] == "cognito_sub"
        )
        assert column["type"].length == 255

    def test_the_reads_composite_index_is_on_cognito_sub(self, engine) -> None:
        """`(order_id, cognito_sub)` is what the user-scoped reads actually filter
        on, so that is the composite that must exist."""
        indexes = {
            index["name"]: index["column_names"]
            for index in inspect(engine).get_indexes("tracking")
        }
        assert indexes.get("idx_tracking_order_id_cognito_sub") == [
            "order_id",
            "cognito_sub",
        ]

    def test_order_id_is_unique(self, engine) -> None:
        constraints = inspect(engine).get_unique_constraints("tracking")
        assert any(c["column_names"] == ["order_id"] for c in constraints)

    @pytest.mark.parametrize("table", ["tracking", "tracking_history"])
    def test_audit_and_soft_delete_columns_exist(self, engine, table: str) -> None:
        columns = {c["name"] for c in inspect(engine).get_columns(table)}
        assert {
            "created_by",
            "created_at",
            "updated_by",
            "updated_at",
            "deleted_by",
            "deleted_at",
        } <= columns

    def test_id_column_is_wide_enough_for_a_prefixed_nano_id(self, engine) -> None:
        """The regression guard for the spec's VARCHAR(21).

        A real id is prefix (4) + nano-ID (21) = 25 chars, so a 21-wide column
        would truncate every id it stored.
        """
        column = next(
            c for c in inspect(engine).get_columns("tracking") if c["name"] == "id"
        )
        assert column["type"].length >= len(new_tracking_id())


class TestCreate:
    """The persistence path behind `POST /v1/trackings/init-tracking`."""

    def test_persists_a_tracking_with_a_prefixed_id(
        self, repo: TrackingRepository
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_create0000000000001")
        assert tracking.id.startswith(TRACKING_PREFIX)
        assert len(tracking.id) == len(TRACKING_PREFIX) + 21

    def test_id_survives_a_round_trip_untruncated(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Reads the id back out of MySQL, not out of the in-memory object."""
        tracking = make_tracking(repo, order_id="ord_create0000000000002")
        session.expire_all()
        stored = session.execute(
            text("SELECT id FROM tracking WHERE order_id = :oid"),
            {"oid": "ord_create0000000000002"},
        ).scalar_one()
        assert stored == tracking.id

    def test_starts_at_shipped(self, repo: TrackingRepository) -> None:
        tracking = make_tracking(repo, order_id="ord_create0000000000003")
        assert tracking.status == TrackingStatus.SHIPPED

    def test_writes_the_first_history_entry(self, repo: TrackingRepository) -> None:
        """A tracking is never created without its opening transition."""
        tracking = make_tracking(repo, order_id="ord_create0000000000004")
        history = repo.get_history(tracking.id)
        assert [h.status for h in history] == [TrackingStatus.SHIPPED]

    def test_shipping_address_round_trips_as_a_dict(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """The JSON column: a mock would accept anything here."""
        tracking = make_tracking(repo, order_id="ord_create0000000000005")
        session.expire_all()
        reloaded = session.get(Tracking, tracking.id)
        assert reloaded is not None
        assert reloaded.shipping_address == ADDRESS

    def test_shipping_address_may_be_absent(self, repo: TrackingRepository) -> None:
        """A caller that could not resolve an address still gets a tracking."""
        tracking = make_tracking(
            repo, order_id="ord_create0000000000006", address=None
        )
        assert tracking.shipping_address is None

    def test_duplicate_order_id_is_rejected_by_the_database(
        self, repo: TrackingRepository
    ) -> None:
        """The unique constraint, not an application pre-check, is the guarantee."""
        make_tracking(repo, order_id="ord_dup00000000000000001")
        with pytest.raises(IntegrityError):
            repo.create(
                order_id="ord_dup00000000000000001",
                user_id="usr_bbbbbbbbbbbbbbbbbbbbb",
            )
            repo.session.commit()
        repo.session.rollback()

    def test_stamps_audit_fields_with_a_semantic_actor(
        self, repo: TrackingRepository
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_create0000000000007")
        assert tracking.created_by == AuditActor.CREATE_TRACKING
        assert tracking.updated_by == AuditActor.CREATE_TRACKING
        assert tracking.created_at is not None
        assert tracking.updated_at is not None
        assert tracking.deleted_at is None
        assert tracking.is_deleted is False


class TestGetByOrderId:
    """Single read, in both of the repository's modes.

    **Scoped** (`cognito_sub=...`) is what every endpoint uses. **Unscoped** is
    still supported and still tested — the TestMode progression needs it, and the
    scoping predicate is exactly the thing that must keep working — but no served
    endpoint reaches it since JE-108 removed the gRPC reads that did.
    """

    def test_unscoped_finds_any_tracking(self, repo: TrackingRepository) -> None:
        make_tracking(repo, order_id="ord_get00000000000000001", user_id="usr_owner")
        found = repo.get_by_order_id("ord_get00000000000000001")
        assert found is not None
        assert found.user_id == "usr_owner"

    def test_unknown_order_id_returns_none(self, repo: TrackingRepository) -> None:
        assert repo.get_by_order_id("ord_nope0000000000000001") is None

    def test_scoped_finds_the_owner_s_tracking(
        self, repo: TrackingRepository
    ) -> None:
        make_tracking(
            repo,
            order_id="ord_get00000000000000002",
            user_id="usr_owner",
            cognito_sub="sub-owner",
        )
        found = repo.get_by_order_id(
            "ord_get00000000000000002", cognito_sub="sub-owner"
        )
        assert found is not None

    def test_scoped_hides_another_user_s_tracking(
        self, repo: TrackingRepository
    ) -> None:
        """The 404-not-403 rule: indistinguishable from a missing tracking."""
        make_tracking(
            repo,
            order_id="ord_get00000000000000003",
            user_id="usr_owner",
            cognito_sub="sub-owner",
        )
        assert (
            repo.get_by_order_id(
                "ord_get00000000000000003", cognito_sub="sub-other"
            )
            is None
        )

    def test_scoping_by_the_internal_user_id_finds_nothing(
        self, repo: TrackingRepository
    ) -> None:
        """THE regression guard for the identity defect.

        The scope is the Cognito sub. Passing the row's own INTERNAL `usr_` id —
        the value Orders sends and the column stores — must match nothing, because
        that is not the identity a caller presents. Before the fix the repository
        filtered on `user_id`, so every real read compared a sub against a `usr_`
        id and returned None for the rightful owner.
        """
        make_tracking(
            repo,
            order_id="ord_get00000000000000006",
            user_id="usr_owner",
            cognito_sub="sub-owner",
        )
        assert (
            repo.get_by_order_id(
                "ord_get00000000000000006", cognito_sub="usr_owner"
            )
            is None
        )

    def test_a_null_cognito_sub_row_matches_no_caller(
        self, repo: TrackingRepository
    ) -> None:
        """A row created before the field existed is invisible to the scoped read,
        never attributed to whoever happens to ask. NULL matches nothing in SQL,
        which is the correct failure direction."""
        make_tracking(
            repo,
            order_id="ord_get00000000000000007",
            user_id="usr_owner",
            cognito_sub=None,
        )
        assert (
            repo.get_by_order_id("ord_get00000000000000007", cognito_sub="sub-owner")
            is None
        )
        # ...but the unscoped read still returns it.
        assert repo.get_by_order_id("ord_get00000000000000007") is not None

    def test_the_same_row_is_visible_unscoped_and_hidden_scoped(
        self, repo: TrackingRepository
    ) -> None:
        """One row, two modes, two answers — the whole point of the scoping.

        This is why the endpoints must go through `queries/get_my_trackings.py`:
        the difference between "yours" and "anyone's" is a single keyword argument.
        """
        make_tracking(
            repo,
            order_id="ord_get00000000000000004",
            user_id="usr_owner",
            cognito_sub="sub-owner",
        )
        assert repo.get_by_order_id("ord_get00000000000000004") is not None
        assert (
            repo.get_by_order_id(
                "ord_get00000000000000004", cognito_sub="sub-other"
            )
            is None
        )

    def test_history_is_loaded_with_the_tracking(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_get00000000000000005")
        repo.update_status(
            tracking=tracking,
            status=TrackingStatus.ON_THE_WAY,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )
        session.commit()
        session.expire_all()

        found = repo.get_by_order_id("ord_get00000000000000005")
        assert found is not None
        assert [h.status for h in found.history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
        ]


class TestGetByOrderIds:
    """Batch read — same scoping switch, one query."""

    def test_returns_every_requested_tracking(
        self, repo: TrackingRepository
    ) -> None:
        for n in range(3):
            make_tracking(repo, order_id=f"ord_batch000000000000{n:03d}")
        found = repo.get_by_order_ids(
            ["ord_batch000000000000000", "ord_batch000000000000001"]
        )
        assert len(found) == 2

    def test_empty_input_returns_empty_without_querying(
        self, repo: TrackingRepository
    ) -> None:
        assert repo.get_by_order_ids([]) == []

    def test_unknown_ids_are_omitted_not_errors(
        self, repo: TrackingRepository
    ) -> None:
        make_tracking(repo, order_id="ord_batch000000000000010")
        found = repo.get_by_order_ids(
            ["ord_batch000000000000010", "ord_missing000000000001"]
        )
        assert [t.order_id for t in found] == ["ord_batch000000000000010"]

    def test_scoped_omits_other_users_silently(
        self, repo: TrackingRepository
    ) -> None:
        """Pass three, own one, get one — with no indication about the other two."""
        make_tracking(
            repo,
            order_id="ord_batch000000000000020",
            user_id="usr_mine",
            cognito_sub="sub-mine",
        )
        make_tracking(
            repo,
            order_id="ord_batch000000000000021",
            user_id="usr_other",
            cognito_sub="sub-other",
        )
        make_tracking(
            repo,
            order_id="ord_batch000000000000022",
            user_id="usr_other",
            cognito_sub="sub-other",
        )

        found = repo.get_by_order_ids(
            [
                "ord_batch000000000000020",
                "ord_batch000000000000021",
                "ord_batch000000000000022",
            ],
            cognito_sub="sub-mine",
        )
        assert [t.order_id for t in found] == ["ord_batch000000000000020"]

    def test_scoping_the_batch_by_the_internal_user_id_finds_nothing(
        self, repo: TrackingRepository
    ) -> None:
        """The batch half of the identity regression guard."""
        make_tracking(
            repo,
            order_id="ord_batch000000000000023",
            user_id="usr_mine",
            cognito_sub="sub-mine",
        )
        assert (
            repo.get_by_order_ids(
                ["ord_batch000000000000023"], cognito_sub="usr_mine"
            )
            == []
        )

    def test_unscoped_returns_all_three(self, repo: TrackingRepository) -> None:
        make_tracking(repo, order_id="ord_batch000000000000030", user_id="usr_mine")
        make_tracking(repo, order_id="ord_batch000000000000031", user_id="usr_other")
        found = repo.get_by_order_ids(
            ["ord_batch000000000000030", "ord_batch000000000000031"]
        )
        assert len(found) == 2


class TestUpdateStatus:
    """Status transitions and their history rows."""

    def test_moves_the_tracking_forward(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_upd00000000000000001")
        repo.update_status(
            tracking=tracking,
            status=TrackingStatus.ON_THE_WAY,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )
        session.commit()
        session.expire_all()

        reloaded = session.get(Tracking, tracking.id)
        assert reloaded is not None
        assert reloaded.status == TrackingStatus.ON_THE_WAY

    def test_appends_a_history_row_per_transition(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_upd00000000000000002")
        for status in (
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            repo.update_status(
                tracking=tracking,
                status=status,
                actor=AuditActor.TEST_MODE_PROGRESSION,
            )
        session.commit()

        history = repo.get_history(tracking.id)
        # A completed TestMode run leaves exactly 4 entries (the design's table).
        assert [h.status for h in history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ]

    def test_the_returned_entitys_history_includes_the_new_transition(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Regression (JE-94): the updated entity must not report a stale history.

        `append_history_entry` adds the row to the SESSION, not to the loaded
        `tracking.history` collection — so an entity that came from a READ (where
        `lazy="selectin"` already populated that collection) kept the pre-update
        history after being updated.

        Invisible to any caller that re-reads the tracking, which is why it
        survived Phase B/C. The carrier PUT is the first caller to render its
        response off the just-updated entity, and it reported the new status
        alongside a history that did not contain it — a transition that had
        provably happened and left no trace in the log whose entire purpose is to
        record it. `update_status` now expires the attribute so the next access
        reloads it.
        """
        # Fetched, not the object `create` returned: `get_by_order_id` is what
        # populates the eager collection, and the stale copy is the bug.
        make_tracking(repo, order_id="ord_upd00000000000000009")
        session.commit()
        fetched = repo.get_by_order_id("ord_upd00000000000000009")
        assert fetched is not None
        assert [h.status for h in fetched.history] == [TrackingStatus.SHIPPED]

        updated = repo.update_status(
            tracking=fetched,
            status=TrackingStatus.ON_THE_WAY,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )

        assert [h.status for h in updated.history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
        ]

    def test_history_is_ordered_by_time_not_alphabetically(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """`DELIVERED` sorts first alphabetically; it must come last here."""
        tracking = make_tracking(repo, order_id="ord_upd00000000000000003")
        # Anchored to the tracking's own SHIPPED row, not to a wall-clock literal.
        # `make_tracking` stamps SHIPPED with the real current time, so a fixed
        # base like 2026-07-29 12:00 puts every later transition BEFORE the
        # creation whenever the suite runs after midday — SHIPPED then sorts last
        # by timestamp, correctly, and the assertion fails for a reason that has
        # nothing to do with alphabetical ordering.
        base = tracking.datetime_
        for offset, status in enumerate(
            (
                TrackingStatus.ON_THE_WAY,
                TrackingStatus.OUT_FOR_DELIVERY,
                TrackingStatus.DELIVERED,
            ),
            start=1,
        ):
            repo.update_status(
                tracking=tracking,
                status=status,
                actor=AuditActor.TEST_MODE_PROGRESSION,
                now=base + timedelta(seconds=10 * offset),
            )
        session.commit()

        history = repo.get_history(tracking.id)
        assert history[-1].status == TrackingStatus.DELIVERED

    def test_history_order_survives_identical_timestamps(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Regression: a bare `datetime` sort is not deterministic.

        All four transitions are written at the SAME instant here — which is what
        happens when several transitions land in one unit of work, or when a
        carrier sends two updates inside the same second. With only `datetime` in
        the ORDER BY, MySQL fell back to primary-key order, which for
        `(tracking_id, status)` is alphabetical: DELIVERED came back first and
        SHIPPED last, exactly reversed at both ends. Caught by this suite running
        against real MySQL; a mock would have returned insertion order and passed.
        """
        frozen = datetime(2026, 7, 29, 12, 0, 0)
        tracking = repo.create(
            order_id="ord_tie00000000000000001",
            user_id="usr_aaaaaaaaaaaaaaaaaaaaa",
            now=frozen,
        )
        for status in (
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            repo.update_status(
                tracking=tracking,
                status=status,
                actor=AuditActor.TEST_MODE_PROGRESSION,
                now=frozen,
            )
        session.commit()
        session.expire_all()

        # Every row shares one timestamp...
        history = repo.get_history(tracking.id)
        assert {h.datetime_ for h in history} == {frozen}
        # ...and the progression order still holds, via the tiebreaker.
        assert [h.status for h in history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ]

        # The relationship must agree with the explicit query.
        reloaded = repo.get_by_order_id("ord_tie00000000000000001")
        assert reloaded is not None
        assert [h.status for h in reloaded.history] == [
            h.status for h in history
        ]

    def test_bumps_the_status_datetime_and_audit_columns(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        created_at_moment = datetime(2026, 7, 29, 8, 0, 0)
        tracking = repo.create(
            order_id="ord_upd00000000000000004",
            user_id="usr_aaaaaaaaaaaaaaaaaaaaa",
            now=created_at_moment,
        )
        session.commit()

        later = created_at_moment + timedelta(minutes=5)
        repo.update_status(
            tracking=tracking,
            status=TrackingStatus.ON_THE_WAY,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
            now=later,
        )
        session.commit()

        assert tracking.datetime_ == later
        assert tracking.updated_at == later
        assert tracking.updated_by == AuditActor.CARRIER_STATUS_UPDATE
        # created_* must not move on an update.
        assert tracking.created_at == created_at_moment
        assert tracking.created_by == AuditActor.CREATE_TRACKING

    def test_history_rows_copy_identity_from_the_tracking(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(
            repo, order_id="ord_upd00000000000000005", user_id="usr_owner"
        )
        session.commit()
        entry = repo.get_history(tracking.id)[0]
        assert entry.user_id == "usr_owner"
        assert entry.order_id == "ord_upd00000000000000005"

    def test_repeating_a_status_violates_the_composite_pk(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """The PK enforces the same invariant the state machine does.

        `(tracking_id, status)` means at most one row per status — the database's
        own statement of "the same status can never be entered twice". The state
        machine rejects such an update before it ever gets here; this proves the
        second line of defense is real.
        """
        tracking = make_tracking(repo, order_id="ord_upd00000000000000006")
        repo.append_history_entry(
            tracking=tracking,
            status=TrackingStatus.SHIPPED,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )
        with pytest.raises(IntegrityError):
            session.commit()
        session.rollback()


class TestSoftDelete:
    """No hard deletes: reads exclude soft-deleted rows by default."""

    def test_soft_deleted_tracking_is_hidden_from_the_single_read(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_del00000000000000001")
        tracking.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        tracking.deleted_by = AuditActor.CARRIER_STATUS_UPDATE
        session.commit()

        assert repo.get_by_order_id("ord_del00000000000000001") is None

    def test_soft_deleted_tracking_is_hidden_from_the_batch_read(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_del00000000000000002")
        tracking.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        session.commit()

        assert repo.get_by_order_ids(["ord_del00000000000000002"]) == []

    def test_the_row_still_physically_exists(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Soft delete, not deletion: the data stays recoverable and auditable."""
        tracking = make_tracking(repo, order_id="ord_del00000000000000003")
        tracking.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        session.commit()

        count = session.execute(
            text("SELECT COUNT(*) FROM tracking WHERE order_id = :oid"),
            {"oid": "ord_del00000000000000003"},
        ).scalar_one()
        assert count == 1

    def test_soft_deleted_history_is_excluded(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_del00000000000000004")
        entry = repo.get_history(tracking.id)[0]
        entry.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        session.commit()

        assert repo.get_history(tracking.id) == []

    def test_is_deleted_is_computed_not_stored(
        self, engine, repo: TrackingRepository, session: Session
    ) -> None:
        columns = {c["name"] for c in inspect(engine).get_columns("tracking")}
        assert "is_deleted" not in columns

        tracking = make_tracking(repo, order_id="ord_del00000000000000005")
        assert tracking.is_deleted is False
        tracking.deleted_at = datetime(2026, 7, 29, 12, 0, 0)
        assert tracking.is_deleted is True


class TestTagsColumn:
    """`tracking.tags` is a JSON array — MySQL has no array type."""

    def test_a_tracking_defaults_to_no_tags(
        self, repo: TrackingRepository
    ) -> None:
        """`[]`, never NULL.

        The distinction is load-bearing rather than cosmetic:
        `JSON_CONTAINS(NULL, …)` evaluates to NULL, not false, so a NULL row would
        fall out of the cleanup's predicate for a reason indistinguishable from a
        bug. `[]` gives "no tags" exactly one spelling.
        """
        tracking = make_tracking(repo, order_id="ord_tag00000000000000001")
        assert tracking.tags == []

    def test_the_column_is_not_nullable(self, engine) -> None:
        """Pinned at the schema, not just in the model.

        The ORM default only applies to rows this code inserts; NOT NULL is what
        holds for a backfill or a manual fix that never goes through it.
        """
        column = next(
            c for c in inspect(engine).get_columns("tracking") if c["name"] == "tags"
        )
        assert column["nullable"] is False

    def test_tags_survive_a_round_trip_through_mysql(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """A real round trip: JSON is serialized by the driver, not by us.

        Read back on a fresh snapshot rather than off the in-memory entity, which
        would assert nothing about what MySQL actually stored.
        """
        make_tracking(
            repo, order_id="ord_tag00000000000000002", tags=[E2E_SOURCE_TAG]
        )
        session.expire_all()

        stored = repo.get_by_order_id("ord_tag00000000000000002")
        assert stored is not None
        assert stored.tags == [E2E_SOURCE_TAG]


class TestSoftDeleteByTag:
    """The E2E teardown's write path — unscoped, and gated only by the tag.

    This is a mass soft-delete with no caller scoping at all, so the tag predicate
    is the ONLY thing standing between it and real users' data. Every shape of row
    it must not touch is pinned explicitly.
    """

    def test_deletes_the_tagged_trackings(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        tracking = make_tracking(
            repo, order_id="ord_swp00000000000000001", tags=[E2E_SOURCE_TAG]
        )

        deleted = repo.soft_delete_by_tag(
            E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP
        )
        session.commit()
        session.expire_all()

        assert deleted == 1
        assert repo.get_by_order_id("ord_swp00000000000000001") is None
        assert session.get(Tracking, tracking.id).is_deleted

    def test_leaves_untagged_trackings_alone(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """The property that replaced caller scoping."""
        make_tracking(repo, order_id="ord_swp00000000000000002")

        deleted = repo.soft_delete_by_tag(
            E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP
        )
        session.commit()

        assert deleted == 0
        assert repo.get_by_order_id("ord_swp00000000000000002") is not None

    def test_the_match_is_the_exact_tag_value(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """`JSON_CONTAINS` compares whole elements — a near miss is not a match.

        Worth pinning because the failure would be silent in the safe direction on
        one side and the unsafe direction on the other: a spelling drift between
        the writer and this predicate leaves fixtures accumulating forever, while a
        prefix/substring match would start sweeping up rows nobody tagged.
        """
        make_tracking(
            repo, order_id="ord_swp00000000000000003", tags=["e2e source"]
        )
        make_tracking(
            repo, order_id="ord_swp00000000000000004", tags=["E2E Source Extra"]
        )

        deleted = repo.soft_delete_by_tag(
            E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP
        )
        session.commit()

        assert deleted == 0

    def test_matches_the_tag_among_others(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Membership, not equality of the whole array."""
        make_tracking(
            repo,
            order_id="ord_swp00000000000000005",
            tags=["first", E2E_SOURCE_TAG, "last"],
        )

        deleted = repo.soft_delete_by_tag(
            E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP
        )
        session.commit()

        assert deleted == 1

    def test_stamps_the_cleanup_actor_and_keeps_the_row(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Soft delete: the row stays, stamped by the HARNESS, not a user.

        The database user has no `DELETE` privilege, so a hard delete would fail
        against the real server anyway — but the actor is the part a shortcut would
        get wrong silently.
        """
        tracking = make_tracking(
            repo, order_id="ord_swp00000000000000006", tags=[E2E_SOURCE_TAG]
        )
        repo.soft_delete_by_tag(E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP)
        session.commit()
        session.expire_all()

        count = session.execute(
            text("SELECT COUNT(*) FROM tracking WHERE id = :tid"),
            {"tid": tracking.id},
        ).scalar_one()
        assert count == 1

        stamped = session.get(Tracking, tracking.id)
        assert stamped.deleted_by == AuditActor.E2E_CLEANUP.value
        assert stamped.deleted_at is not None

    def test_cascades_to_history_through_the_foreign_key(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """`tracking_history` has no `tags` of its own — it is reached by FK.

        Leaving the children live would strand a readable transition trail under a
        parent no read can reach.
        """
        tagged = make_tracking(
            repo, order_id="ord_swp00000000000000007", tags=[E2E_SOURCE_TAG]
        )
        untagged = make_tracking(repo, order_id="ord_swp00000000000000008")

        repo.soft_delete_by_tag(E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP)
        session.commit()
        session.expire_all()

        assert repo.get_history(tagged.id) == []
        # …and only the tagged parent's children moved.
        assert repo.get_history(untagged.id) != []

    def test_a_second_run_stamps_nothing(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """Idempotent, via the `deleted_at IS NULL` guard on each statement.

        Without it the second run would re-stamp the same rows with a later
        timestamp, quietly rewriting when they were removed.
        """
        make_tracking(
            repo, order_id="ord_swp00000000000000009", tags=[E2E_SOURCE_TAG]
        )
        assert (
            repo.soft_delete_by_tag(E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP)
            == 1
        )
        session.commit()

        assert (
            repo.soft_delete_by_tag(E2E_SOURCE_TAG, actor=AuditActor.E2E_CLEANUP)
            == 0
        )


class TestReprDoesNotLeakPii:
    """The shipping address is PII and must never reach a log line."""

    def test_tracking_repr_omits_the_address(
        self, repo: TrackingRepository
    ) -> None:
        tracking = make_tracking(repo, order_id="ord_pii00000000000000001")
        rendered = repr(tracking)
        assert "Evergreen" not in rendered
        assert "Springfield" not in rendered
        assert tracking.order_id in rendered


class TestHistoryModel:
    """Direct model-level checks not covered through the repository."""

    def test_two_trackings_may_share_a_status(
        self, repo: TrackingRepository, session: Session
    ) -> None:
        """The composite PK scopes uniqueness per tracking, not globally."""
        a = make_tracking(repo, order_id="ord_hist0000000000000001")
        b = make_tracking(repo, order_id="ord_hist0000000000000002")
        session.commit()
        assert (
            session.get(TrackingHistory, (a.id, TrackingStatus.SHIPPED.value))
            is not None
        )
        assert (
            session.get(TrackingHistory, (b.id, TrackingStatus.SHIPPED.value))
            is not None
        )
