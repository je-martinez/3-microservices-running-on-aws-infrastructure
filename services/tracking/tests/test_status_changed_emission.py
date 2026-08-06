"""`update_tracking_status` emits `TRACKING_STATUS_CHANGED` — against real MySQL.

Where `test_sqs_event_publisher.py` pins the envelope the publisher BUILDS, this
module pins what the command HANDS it, and what happens to the transition when
publishing goes wrong. Both halves need the real database: the whole point of the
`user_id` assertion is that the value comes off a persisted row, which a mocked
repository would have supplied itself.

## The three things that are easy to get wrong here

1. **`user_id` is the PERSISTED one.** The carrier webhook's gateway route has no
   Cognito authorizer, so the request carries no `x-user-id` at all — there is
   nothing to reach for, and an implementer who reached for one would ship an
   event with no real owner. `TestUserIdComesFromThePersistedRow` seeds a row
   owned by user A and drives the transition with NO identity header (and,
   separately, with a stray header naming user B), requiring A either way.

2. **A publish failure must not fail the transition.** The write is already
   committed when emission runs. A 500 would make the carrier retry the same
   status change, which the forward-only guard then rejects as a `400
   not_strictly_forward` — a permanent-looking failure for a change we actually
   recorded.

3. **`ValidationError` is a `ValueError`.** `shared_event_publisher()` reads
   settings, and pydantic raises `ValidationError` on an incomplete environment;
   `carrier_router` catches `ValueError` to mean "`parse_status` rejected the
   status". Without `_emit_status_changed`'s own guard, a misconfigured
   environment surfaces as `400 invalid_status` — blaming the caller for a
   transition already written. `TestSettingsFailureDoesNotBecomeInvalidStatus`
   is the regression.

## Recording fake, never a Mock

`RecordingPublisher` stores the kwargs it was called with. Assertions are on
those recorded values — never on a return value the test itself configured.
`NoopEventPublisher` is deliberately NOT used for the positive assertions: it
records nothing, so a test bound to it cannot fail when the call stops happening.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.features.tracking.commands.update_status import (
    TrackingNotFoundError,
    UpdateTrackingStatusCommand,
    update_tracking_status,
)
from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import (
    InvalidTransitionError,
    TrackingStatus,
    TransitionRejectionReason,
)
from src.shared.audit.audit_actor import AuditActor
from src.shared.messaging.event_publisher import NoopEventPublisher
from tests.conftest import TEST_CARRIER_API_KEY

pytestmark = pytest.mark.integration

#: Two DIFFERENT values, deliberately. The row's owner and the (never-present,
#: sometimes-stray) header identity must not be confusable — a test using one
#: value for both cannot fail when the emission starts reading the request.
OWNER = "usr_owner00000000000001"
IMPOSTOR = "usr_impostor000000000001"
COGNITO_SUB = "22222222-2222-4222-8222-222222222222"
#: A sub-shaped stray identity, for the header a carrier could send but must not
#: be believed. Sub-shaped rather than `usr_`-shaped because `x-user-id` carries
#: the JWT's `sub` on the authenticated routes — so this is what a plausible
#: forgery actually looks like, and comparing against `IMPOSTOR` would let an
#: implementation reading the header slip through on shape alone.
IMPOSTOR_SUB = "33333333-3333-4333-8333-333333333333"


class RecordingPublisher:
    """Records each `publish_tracking_status_changed` call's kwargs, in order."""

    def __init__(self) -> None:
        self.published: list[dict[str, Any]] = []

    def publish_tracking_status_changed(self, **kwargs: Any) -> None:
        self.published.append(kwargs)


class ExplodingPublisher:
    """Raises on publish — a publisher that does NOT honour the swallow policy.

    Stands in for the layer beneath `SqsEventPublisher`'s own try/except: a
    client construction failure, an import error, a settings problem. The command
    must absorb it regardless of who failed.
    """

    def __init__(self, error: Exception | None = None) -> None:
        self.calls = 0
        self._error = error or RuntimeError("publisher exploded")

    def publish_tracking_status_changed(self, **kwargs: Any) -> None:
        self.calls += 1
        raise self._error


def seed(
    session: Session,
    *,
    order_id: str,
    user_id: str = OWNER,
    cognito_sub: str | None = COGNITO_SUB,
    status: TrackingStatus = TrackingStatus.SHIPPED,
) -> str:
    """A committed tracking owned by `user_id`, at `status`.

    `cognito_sub` is overridable — and specifically nullable — because the column
    is: rows created by a caller that omitted the optional wire field hold NULL,
    and the emission has to survive that (see
    `TestTheCognitoSubComesFromThePersistedRow`).
    """
    tracking = TrackingRepository(session).create(
        order_id=order_id,
        user_id=user_id,
        cognito_sub=cognito_sub,
        status=status,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def reload(session: Session, order_id: str):
    session.expire_all()
    found = TrackingRepository(session).get_by_order_id(order_id)
    assert found is not None
    return found


def advance(
    session: Session,
    order_id: str,
    status: TrackingStatus,
    *,
    publisher: Any,
    actor: AuditActor = AuditActor.CARRIER_STATUS_UPDATE,
):
    """Drive the command directly, with an explicit publisher."""
    return update_tracking_status(
        session,
        UpdateTrackingStatusCommand(order_id=order_id, status=status),
        actor=actor,
        publisher=publisher,
    )


def carrier() -> dict[str, str]:
    return {"x-api-key": TEST_CARRIER_API_KEY}


class TestItPublishesOnEverySuccessfulTransition:
    def test_a_transition_publishes_exactly_one_event(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_emit00000000000001")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert len(publisher.published) == 1

    def test_it_publishes_the_transition_it_just_applied(
        self, session: Session
    ) -> None:
        """`status` is the new one and `previous_status` the old one — inverted,
        the email would announce the status the parcel just left."""
        seed(
            session,
            order_id="ord_emit00000000000002",
            status=TrackingStatus.ON_THE_WAY,
        )
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000002",
            TrackingStatus.OUT_FOR_DELIVERY,
            publisher=publisher,
        )
        event = publisher.published[0]

        assert event["status"] == TrackingStatus.OUT_FOR_DELIVERY
        assert event["previous_status"] == TrackingStatus.ON_THE_WAY

    def test_it_publishes_the_order_id(self, session: Session) -> None:
        seed(session, order_id="ord_emit00000000000003")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000003",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.published[0]["order_id"] == "ord_emit00000000000003"

    def test_changed_at_is_the_transitions_own_timestamp(
        self, session: Session
    ) -> None:
        """`updated_at` moves on ANY write; the event must carry the moment the
        status changed. Asserted against the PERSISTED `datetime_` column, read
        back from MySQL, not against a value the test supplied."""
        seed(session, order_id="ord_emit00000000000004")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000004",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )
        persisted = reload(session, "ord_emit00000000000004")
        changed_at = publisher.published[0]["changed_at"]

        assert isinstance(changed_at, datetime)
        assert changed_at == persisted.datetime_

    def test_delivered_is_published_like_any_other_transition(
        self, session: Session
    ) -> None:
        """There is no suppression on the terminal status — the "delivered"
        email is the one users most expect."""
        seed(
            session,
            order_id="ord_emit00000000000005",
            status=TrackingStatus.OUT_FOR_DELIVERY,
        )
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000005",
            TrackingStatus.DELIVERED,
            publisher=publisher,
        )

        assert publisher.published[0]["status"] == TrackingStatus.DELIVERED

    def test_a_full_progression_publishes_four_events(
        self, session: Session
    ) -> None:
        """The count a completed TestMode run produces. Asserted as the ordered
        sequence, so a duplicate or a skipped step fails too."""
        seed(session, order_id="ord_emit00000000000006")
        publisher = RecordingPublisher()

        for status in (
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ):
            advance(
                session,
                "ord_emit00000000000006",
                status,
                publisher=publisher,
            )

        assert [event["status"] for event in publisher.published] == [
            TrackingStatus.ON_THE_WAY,
            TrackingStatus.OUT_FOR_DELIVERY,
            TrackingStatus.DELIVERED,
        ]

    def test_the_testmode_actor_publishes_the_same_way(
        self, session: Session
    ) -> None:
        """`actor` is the only thing that differs between the command's two
        callers; emission must not be one of the differences, or the automatic
        path would stop notifying."""
        seed(session, order_id="ord_emit00000000000007")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_emit00000000000007",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.TEST_MODE_PROGRESSION,
        )

        assert len(publisher.published) == 1


class TestTheActorReachesThePublisher:
    """The actor is the envelope's AUTHOR, and the command's two callers are the
    only thing it distinguishes.

    A publisher that hardcoded its own constant would pass every other test in
    this file — the event would still be published, with every other field
    right — while labelling every automatic TestMode transition as a real
    third-party carrier update. That is the one confusion the semantic actor
    exists to prevent, so both callers are pinned here.
    """

    def test_the_carrier_path_publishes_its_own_actor(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_auth00000000000001")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_auth00000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )

        assert publisher.published[0]["actor"] is AuditActor.CARRIER_STATUS_UPDATE
        # The wire value, pinned as a literal: the enum could be renamed without
        # the consumer noticing, but not re-valued.
        assert (
            publisher.published[0]["actor"].value
            == "tracking_api:carrier_status_update"
        )

    def test_the_testmode_path_publishes_its_own_actor(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_auth00000000000002")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_auth00000000000002",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.TEST_MODE_PROGRESSION,
        )

        assert publisher.published[0]["actor"] is AuditActor.TEST_MODE_PROGRESSION
        assert (
            publisher.published[0]["actor"].value
            == "tracking_api:test_mode_progression"
        )

    def test_the_two_paths_publish_different_actors(
        self, session: Session
    ) -> None:
        """The property the two tests above imply, asserted directly: a
        hardcoded constant satisfies each of them in isolation only if it happens
        to be the one they expect, but nothing can satisfy this one."""
        seed(session, order_id="ord_auth00000000000003")
        seed(session, order_id="ord_auth00000000000004")
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_auth00000000000003",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.CARRIER_STATUS_UPDATE,
        )
        advance(
            session,
            "ord_auth00000000000004",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.TEST_MODE_PROGRESSION,
        )

        assert (
            publisher.published[0]["actor"] != publisher.published[1]["actor"]
        )


class TestNothingIsPublishedForANonTransition:
    """The event announces a state change; a call that changed no state must not
    produce one, or a rejected replay would mail the user again."""

    def test_a_rejected_transition_publishes_nothing(
        self, session: Session
    ) -> None:
        seed(
            session,
            order_id="ord_norm00000000000001",
            status=TrackingStatus.DELIVERED,
        )
        publisher = RecordingPublisher()

        with pytest.raises(InvalidTransitionError):
            advance(
                session,
                "ord_norm00000000000001",
                TrackingStatus.SHIPPED,
                publisher=publisher,
            )

        assert publisher.published == []

    def test_a_missing_tracking_publishes_nothing(self, session: Session) -> None:
        publisher = RecordingPublisher()

        with pytest.raises(TrackingNotFoundError):
            advance(
                session,
                "ord_norm00000000000002",
                TrackingStatus.ON_THE_WAY,
                publisher=publisher,
            )

        assert publisher.published == []

    def test_an_invalid_status_publishes_nothing(self, session: Session) -> None:
        """Rejected by `parse_status` before anything is even read."""
        seed(session, order_id="ord_norm00000000000003")
        publisher = RecordingPublisher()

        with pytest.raises(ValueError):
            update_tracking_status(
                session,
                UpdateTrackingStatusCommand(
                    order_id="ord_norm00000000000003", status="LOST_IN_SPACE"
                ),
                publisher=publisher,
            )

        assert publisher.published == []


class TestUserIdComesFromThePersistedRow:
    """The trap the pipeline handler's comment warns about.

    The carrier webhook carries NO `x-user-id` — its gateway route has no Cognito
    authorizer. The entity this command already loaded is the only source of an
    owner for the event.
    """

    def test_it_publishes_the_owner_stored_on_the_row(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_uid00000000000001", user_id=OWNER)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_uid00000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.published[0]["user_id"] == OWNER

    def test_the_published_user_id_matches_what_mysql_holds(
        self, session: Session
    ) -> None:
        """Read back from the database rather than compared to the seed constant,
        so this fails if the emission ever reads a value that was never
        persisted."""
        seed(session, order_id="ord_uid00000000000002", user_id=OWNER)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_uid00000000000002",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.published[0]["user_id"] == (
            reload(session, "ord_uid00000000000002").user_id
        )

    def test_it_is_not_the_cognito_sub(self, session: Session) -> None:
        """`cognito_sub` is the ownership key the REST reads filter by, NOT the
        envelope's `user_id`. Users is keyed by the internal id here, so a sub
        would resolve to no email and the notification would be dropped as
        `no_email_for_user`."""
        seed(session, order_id="ord_uid00000000000003", user_id=OWNER)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_uid00000000000003",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )
        published = publisher.published[0]["user_id"]

        assert published != COGNITO_SUB
        assert published.startswith("usr_")

    def test_no_request_header_can_supply_the_user_id(
        self, client: TestClient, session: Session
    ) -> None:
        """Driven through the REAL endpoint with a stray `x-user-id` naming a
        DIFFERENT user. A carrier can send any header it likes; the event's owner
        must still be the row's.

        This is the mutation-sensitive one: change `_emit_status_changed`'s
        `user_id=updated.user_id` to any request-derived value and this fails,
        while every response-shape assertion in the suite keeps passing.
        """
        seed(session, order_id="ord_uid00000000000004", user_id=OWNER)
        publisher = RecordingPublisher()

        with _bound_publisher(publisher):
            response = client.put(
                "/v1/trackings/ord_uid00000000000004/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers={**carrier(), "x-user-id": IMPOSTOR},
            )

        assert response.status_code == 200
        assert publisher.published[0]["user_id"] == OWNER
        assert publisher.published[0]["user_id"] != IMPOSTOR

    def test_it_publishes_the_owner_with_no_identity_header_at_all(
        self, client: TestClient, session: Session
    ) -> None:
        """The shape of a REAL carrier request: the API key and nothing else. An
        emission reading the request would have `None` here."""
        seed(session, order_id="ord_uid00000000000005", user_id=OWNER)
        publisher = RecordingPublisher()

        with _bound_publisher(publisher):
            response = client.put(
                "/v1/trackings/ord_uid00000000000005/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert response.status_code == 200
        assert publisher.published[0]["user_id"] == OWNER


class TestTheCognitoSubComesFromThePersistedRow:
    """`author.cognito_sub` is how the realtime WebSocket push finds its sockets.

    The events-pipeline queries a DynamoDB index keyed on the Cognito `sub` to
    find a user's open connections. The envelope's root `user_id` is the internal
    `usr_` id — a DIFFERENT value — so querying that index with it returns an
    EMPTY list and no error: the push is silently delivered to nobody. The sub
    therefore has to travel on the envelope, and only the persisted row can
    supply it: the carrier webhook is authenticated by an API key, carries no
    `x-user-id`, and the repository lookup here is deliberately unscoped.

    The column is NULLABLE, so the second half of the contract is that a row
    holding None still publishes — it simply cannot be routed to a socket.
    """

    def test_it_publishes_the_sub_stored_on_the_row(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_sub00000000000001", cognito_sub=COGNITO_SUB)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.published[0]["cognito_sub"] == COGNITO_SUB

    def test_the_published_sub_matches_what_mysql_holds(
        self, session: Session
    ) -> None:
        """Read back from the database rather than compared to the seed constant,
        so this fails if the emission ever reads a value that was never
        persisted."""
        seed(session, order_id="ord_sub00000000000002", cognito_sub=COGNITO_SUB)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000002",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.published[0]["cognito_sub"] == (
            reload(session, "ord_sub00000000000002").cognito_sub
        )

    def test_it_is_not_the_internal_user_id(self, session: Session) -> None:
        """The whole reason this field was added: the two identities describe the
        same person and are not interchangeable. A publisher handed the `usr_` id
        here would make the pipeline's index query match nothing — with no
        error — and the realtime push would silently reach no one."""
        seed(
            session,
            order_id="ord_sub00000000000003",
            user_id=OWNER,
            cognito_sub=COGNITO_SUB,
        )
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000003",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )
        event = publisher.published[0]

        assert event["cognito_sub"] != event["user_id"]
        assert not event["cognito_sub"].startswith("usr_")

    def test_a_row_with_no_sub_still_publishes(self, session: Session) -> None:
        """The nullable column, exercised. A row predating `cognito_sub`, or
        created by a caller that omitted the optional wire field, holds NULL. It
        cannot be routed to a websocket, but the email path is unaffected — so
        the event must still be published, carrying no sub."""
        seed(session, order_id="ord_sub00000000000004", cognito_sub=None)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000004",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert len(publisher.published) == 1
        assert publisher.published[0]["cognito_sub"] is None

    def test_a_row_with_no_sub_still_publishes_everything_else(
        self, session: Session
    ) -> None:
        """Guards the test above: "published with no sub" must not degrade into
        an event missing the fields the email actually needs."""
        seed(
            session,
            order_id="ord_sub00000000000005",
            user_id=OWNER,
            cognito_sub=None,
        )
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000005",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )
        event = publisher.published[0]

        assert event["user_id"] == OWNER
        assert event["order_id"] == "ord_sub00000000000005"
        assert event["status"] == TrackingStatus.ON_THE_WAY

    def test_no_request_header_can_supply_the_cognito_sub(
        self, client: TestClient, session: Session
    ) -> None:
        """Driven through the REAL endpoint with a stray `x-user-id` — which, at
        the gateway, is precisely where a sub WOULD arrive on an authenticated
        route. The carrier's route has no authorizer, so anything it sends there
        is unverified and must be ignored; the row's own sub wins.

        This is the mutation-sensitive one: change `_emit_status_changed`'s
        `cognito_sub=updated.cognito_sub` to a request-derived value and this
        fails, while every other assertion in the suite keeps passing.
        """
        seed(
            session,
            order_id="ord_sub00000000000006",
            cognito_sub=COGNITO_SUB,
        )
        publisher = RecordingPublisher()

        with _bound_publisher(publisher):
            response = client.put(
                "/v1/trackings/ord_sub00000000000006/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers={**carrier(), "x-user-id": IMPOSTOR_SUB},
            )

        assert response.status_code == 200
        assert publisher.published[0]["cognito_sub"] == COGNITO_SUB
        assert publisher.published[0]["cognito_sub"] != IMPOSTOR_SUB

    def test_the_testmode_path_publishes_the_sub_too(
        self, session: Session
    ) -> None:
        """TestMode progression shares this write path, and its transitions are
        exactly the ones a user is watching a live UI for."""
        seed(session, order_id="ord_sub00000000000007", cognito_sub=COGNITO_SUB)
        publisher = RecordingPublisher()

        advance(
            session,
            "ord_sub00000000000007",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
            actor=AuditActor.TEST_MODE_PROGRESSION,
        )

        assert publisher.published[0]["cognito_sub"] == COGNITO_SUB


class TestAPublishFailureNeverFailsTheTransition:
    """The policy, asserted at the command level: a raising publisher is absorbed
    and the transition still succeeds.

    Note what is NOT asserted: that the exploding fake explodes. That is this
    test's setup. What is asserted is the command's own behaviour around it — it
    returns the updated entity, MySQL holds the new status, and the failure is on
    the record as an `error` with a `reason`.
    """

    def test_the_command_still_returns_the_updated_tracking(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_fail0000000000001")

        updated = advance(
            session,
            "ord_fail0000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=ExplodingPublisher(),
        )

        assert updated.status == TrackingStatus.ON_THE_WAY

    def test_the_transition_is_still_persisted(self, session: Session) -> None:
        """Asserted against MySQL: the write happens before emission, so a
        propagating exception would not undo it — but a rollback added around the
        emission later would, and this is what would catch that."""
        seed(session, order_id="ord_fail0000000000002")
        session.commit()

        advance(
            session,
            "ord_fail0000000000002",
            TrackingStatus.ON_THE_WAY,
            publisher=ExplodingPublisher(),
        )
        session.commit()

        assert reload(session, "ord_fail0000000000002").status == (
            TrackingStatus.ON_THE_WAY
        )

    def test_the_history_row_still_lands(self, session: Session) -> None:
        seed(session, order_id="ord_fail0000000000003")

        advance(
            session,
            "ord_fail0000000000003",
            TrackingStatus.ON_THE_WAY,
            publisher=ExplodingPublisher(),
        )
        session.commit()

        tracking = reload(session, "ord_fail0000000000003")
        history = TrackingRepository(session).get_history(tracking.id)
        assert [entry.status for entry in history] == [
            TrackingStatus.SHIPPED,
            TrackingStatus.ON_THE_WAY,
        ]

    def test_the_publisher_really_was_called(self, session: Session) -> None:
        """Guards the three tests above: a command that stopped publishing
        altogether would also "not fail", and would pass them vacuously."""
        seed(session, order_id="ord_fail0000000000004")
        publisher = ExplodingPublisher()

        advance(
            session,
            "ord_fail0000000000004",
            TrackingStatus.ON_THE_WAY,
            publisher=publisher,
        )

        assert publisher.calls == 1

    def test_the_failure_is_logged_with_its_reason(
        self, session: Session, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Swallowed, not silent. `publisher_unavailable` is the layer BENEATH
        `SqsEventPublisher`'s own reasons — obtaining a publisher at all."""
        seed(session, order_id="ord_fail0000000000005")

        with caplog.at_level(logging.ERROR):
            advance(
                session,
                "ord_fail0000000000005",
                TrackingStatus.ON_THE_WAY,
                publisher=ExplodingPublisher(),
            )

        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(errors) == 1
        assert errors[0].app_event == "tracking_status_changed_publish_failed"
        assert errors[0].reason == "publisher_unavailable"
        assert errors[0].order_id == "ord_fail0000000000005"

    def test_a_carrier_put_still_answers_200_when_publishing_explodes(
        self, client: TestClient, session: Session
    ) -> None:
        """Through the REAL endpoint. A 500 here makes the carrier retry the same
        transition, which the forward-only guard then rejects — see the class
        docstring."""
        seed(session, order_id="ord_fail0000000000006")

        with _bound_publisher(ExplodingPublisher()):
            response = client.put(
                "/v1/trackings/ord_fail0000000000006/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert response.status_code == 200
        assert response.json()["status"] == TrackingStatus.ON_THE_WAY

    def test_the_row_is_updated_even_though_publishing_exploded(
        self, client: TestClient, session: Session
    ) -> None:
        """The reason a 500 would be actively harmful: the change IS recorded, so
        a retry would hit `not_strictly_forward`."""
        seed(session, order_id="ord_fail0000000000007")

        with _bound_publisher(ExplodingPublisher()):
            client.put(
                "/v1/trackings/ord_fail0000000000007/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert reload(session, "ord_fail0000000000007").status == (
            TrackingStatus.ON_THE_WAY
        )

    def test_a_retry_after_a_failed_publish_is_rejected_as_not_forward(
        self, client: TestClient, session: Session
    ) -> None:
        """The concrete scenario the policy exists to avoid, played out: had the
        first call answered 500, the carrier's retry would get THIS — a
        400 blaming it for a change we recorded."""
        seed(session, order_id="ord_fail0000000000008")

        with _bound_publisher(ExplodingPublisher()):
            first = client.put(
                "/v1/trackings/ord_fail0000000000008/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )
            retry = client.put(
                "/v1/trackings/ord_fail0000000000008/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert first.status_code == 200
        assert retry.status_code == 400
        assert retry.json()["reason"] == (
            TransitionRejectionReason.NOT_STRICTLY_FORWARD
        )


class TestSettingsFailureDoesNotBecomeInvalidStatus:
    """THE regression test for the `ValidationError`-is-a-`ValueError` trap.

    `_emit_status_changed` resolves the default publisher INSIDE its try, so
    `shared_event_publisher()` → `get_settings()` → pydantic `ValidationError`
    (a `ValueError` subclass) cannot escape into `carrier_router`'s
    `except ValueError`, which means "`parse_status` rejected the status" and maps
    to `400 invalid_status`.

    Without that guard, a misconfigured environment answers 400 blaming the
    carrier for a transition that was already written — with a `reason` naming
    entirely the wrong cause.

    The failure is injected as a REAL `pydantic.ValidationError`, produced by
    validating a real incomplete `Settings`, not as a hand-rolled `ValueError`
    subclass: the trap is specifically about pydantic's class hierarchy, so a
    stand-in would be testing the test's own assumption about it.
    """

    #: The fields `Settings` requires. Cleared while provoking the error below,
    #: so an ambient value cannot make the environment look complete.
    REQUIRED_ENV = (
        "DATABASE_WRITER_URL",
        "DATABASE_READER_URL",
        "GRPC_API_KEY",
        "TRACKING_CARRIER_API_KEY",
    )

    @classmethod
    def _real_validation_error(cls) -> Exception:
        """A genuine pydantic `ValidationError` from an incomplete environment.

        Built by constructing `Settings` with the required fields missing —
        exactly what `get_settings()` does in a misconfigured process.

        The required keys are removed from `os.environ` for the duration and
        restored afterwards, because they may be PRESENT when this runs:
        `test_settings.py` sets them through `os.environ` directly rather than
        through monkeypatch, and its cleanup fixture is module-scoped, so the
        values outlive that module in a full-suite run. Reading whatever the
        ambient environment happens to hold would make this helper silently stop
        producing an error — and every assertion in the class vacuous — depending
        only on test ORDER.
        """
        import os

        from pydantic import ValidationError

        from src.shared.config.settings import Settings

        saved = {key: os.environ.pop(key, None) for key in cls.REQUIRED_ENV}
        try:
            # _env_file=None so a developer's real .env cannot complete it either.
            Settings(_env_file=None)  # type: ignore[call-arg]
        except ValidationError as exc:
            return exc
        finally:
            for key, value in saved.items():
                if value is not None:
                    os.environ[key] = value
        raise AssertionError(
            "Settings validated with no environment — this test can no longer "
            "reproduce the ValidationError it guards against"
        )

    def test_the_injected_error_really_is_a_value_error(self) -> None:
        """The premise, asserted rather than assumed. If pydantic ever stopped
        subclassing `ValueError`, the guard would still be correct but this
        suite's other assertions would no longer be testing the trap — and this
        is where that would be noticed."""
        assert isinstance(self._real_validation_error(), ValueError)

    def test_the_transition_still_succeeds_at_the_command_level(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_cfg00000000000001")

        updated = advance(
            session,
            "ord_cfg00000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=ExplodingPublisher(self._real_validation_error()),
        )

        assert updated.status == TrackingStatus.ON_THE_WAY

    def test_a_validation_error_does_not_escape_as_a_value_error(
        self, session: Session
    ) -> None:
        """Stated as the property the router depends on: nothing `ValueError`-ish
        may come out of a transition that succeeded."""
        seed(session, order_id="ord_cfg00000000000002")

        advance(  # would raise if the guard caught something narrower
            session,
            "ord_cfg00000000000002",
            TrackingStatus.ON_THE_WAY,
            publisher=ExplodingPublisher(self._real_validation_error()),
        )

    def test_a_broken_environment_does_not_produce_a_400(
        self, client: TestClient, session: Session
    ) -> None:
        """Through the REAL endpoint, with the DEFAULT publisher path — no
        `publisher` argument anywhere, so `_emit_status_changed` genuinely calls
        `shared_event_publisher()` and genuinely reads settings.

        The environment is broken at the source: `get_settings` is patched to
        raise the real `ValidationError`, which is what an incomplete env does.
        Patched on the settings module rather than on the app's dependency
        overrides because the publisher path does not go through FastAPI's
        dependency injection at all — it calls the module function directly.
        """
        seed(session, order_id="ord_cfg00000000000003")
        error = self._real_validation_error()

        with _broken_settings(error):
            response = client.put(
                "/v1/trackings/ord_cfg00000000000003/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert response.status_code == 200, response.text

    def test_it_is_specifically_not_reported_as_an_invalid_status(
        self, client: TestClient, session: Session
    ) -> None:
        """The precise misdiagnosis: `400 {"reason": "invalid_status"}` for a
        perfectly valid status, on a transition already committed."""
        seed(session, order_id="ord_cfg00000000000004")

        with _broken_settings(self._real_validation_error()):
            response = client.put(
                "/v1/trackings/ord_cfg00000000000004/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert response.status_code != 400
        assert "invalid_status" not in response.text

    def test_the_transition_is_persisted_despite_the_broken_settings(
        self, client: TestClient, session: Session
    ) -> None:
        """The consequence that made the bug misleading: the row DID move, so a
        400 was describing a write that had already happened."""
        seed(session, order_id="ord_cfg00000000000005")

        with _broken_settings(self._real_validation_error()):
            client.put(
                "/v1/trackings/ord_cfg00000000000005/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        assert reload(session, "ord_cfg00000000000005").status == (
            TrackingStatus.ON_THE_WAY
        )

    def test_the_broken_settings_are_logged_as_publisher_unavailable(
        self, client: TestClient, session: Session, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Absorbed is not ignored — the misconfiguration must still be
        alertable, under the reason that names the right cause."""
        seed(session, order_id="ord_cfg00000000000006")

        with caplog.at_level(logging.ERROR), _broken_settings(
            self._real_validation_error()
        ):
            client.put(
                "/v1/trackings/ord_cfg00000000000006/status",
                json={"status": TrackingStatus.ON_THE_WAY},
                headers=carrier(),
            )

        reasons = [
            record.reason
            for record in caplog.records
            if getattr(record, "app_event", None)
            == "tracking_status_changed_publish_failed"
        ]
        assert reasons == ["publisher_unavailable"]

    def test_a_genuinely_invalid_status_is_still_a_400(
        self, client: TestClient, session: Session
    ) -> None:
        """The other side of the isolation: catching the environment's
        `ValueError` must NOT have swallowed `parse_status`'s. A guard that
        widened too far would make garbage statuses answer 200."""
        seed(session, order_id="ord_cfg00000000000007")

        response = client.put(
            "/v1/trackings/ord_cfg00000000000007/status",
            json={"status": "LOST_IN_SPACE"},
            headers=carrier(),
        )

        assert response.status_code == 400
        assert response.json()["reason"] == "invalid_status"


class TestTheDefaultPublisherIsResolvedLazily:
    """Importing the command must not construct a boto3 client nor require an
    environment — which is exactly what lets this suite build an app without
    one."""

    def test_the_default_publisher_is_only_touched_when_none_is_injected(
        self, session: Session
    ) -> None:
        """With a publisher injected, `shared_event_publisher` is never called.
        Patched to raise, so a call would fail loudly rather than silently
        construct a client against a test environment."""
        seed(session, order_id="ord_lazy0000000000001")
        publisher = RecordingPublisher()

        def explode() -> Any:
            raise AssertionError(
                "the shared publisher was built despite one being injected"
            )

        import src.shared.messaging.sqs_event_publisher as module

        original = module.shared_event_publisher
        module.shared_event_publisher = explode  # type: ignore[assignment]
        try:
            advance(
                session,
                "ord_lazy0000000000001",
                TrackingStatus.ON_THE_WAY,
                publisher=publisher,
            )
        finally:
            module.shared_event_publisher = original  # type: ignore[assignment]

        assert len(publisher.published) == 1


class TestNoopPublisher:
    """The port's null implementation: binds where a suite must not emit."""

    def test_it_discards_the_call_without_failing_the_transition(
        self, session: Session
    ) -> None:
        seed(session, order_id="ord_noop0000000000001")

        updated = advance(
            session,
            "ord_noop0000000000001",
            TrackingStatus.ON_THE_WAY,
            publisher=NoopEventPublisher(),
        )

        assert updated.status == TrackingStatus.ON_THE_WAY

    def test_it_returns_none(self) -> None:
        assert (
            NoopEventPublisher().publish_tracking_status_changed(
                order_id="ord_x",
                user_id="usr_x",
                status="SHIPPED",
                previous_status="SHIPPED",
                changed_at=datetime(2026, 8, 3),
                actor=AuditActor.CARRIER_STATUS_UPDATE,
                cognito_sub="sub-x",
            )
            is None
        )

    def test_it_accepts_the_cognito_sub_keyword(self) -> None:
        """The null implementation has to track the port's signature or the
        suites bound to it break on a `TypeError` — the one failure mode a Noop
        exists to prevent. Both variants, since None is not a default here."""
        noop = NoopEventPublisher()

        assert (
            noop.publish_tracking_status_changed(
                order_id="ord_x",
                user_id="usr_x",
                status="SHIPPED",
                previous_status="SHIPPED",
                changed_at=datetime(2026, 8, 3),
                actor=AuditActor.CARRIER_STATUS_UPDATE,
                cognito_sub=None,
            )
            is None
        )


# ------------------------------------------------------------------ helpers
#
# Both helpers patch a MODULE ATTRIBUTE rather than using FastAPI's dependency
# overrides, because the emission path deliberately does not go through the
# dependency system: `_emit_status_changed` imports `shared_event_publisher`
# inside the call (so the import itself stays lazy), and that import resolves the
# name off the module at call time — which is what makes patching there effective.


class _bound_publisher:  # noqa: N801 - a context manager used as a statement
    """Make `shared_event_publisher()` return `publisher` for the block.

    Lets a test drive the REAL HTTP endpoint — full routing, auth and the
    command's default publisher resolution — while still recording what was
    published.
    """

    def __init__(self, publisher: Any) -> None:
        self._publisher = publisher
        self._original: Any = None

    def __enter__(self) -> Any:
        import src.shared.messaging.sqs_event_publisher as module

        self._module = module
        self._original = module.shared_event_publisher
        module.shared_event_publisher = lambda: self._publisher  # type: ignore[assignment]
        return self._publisher

    def __exit__(self, *exc: Any) -> None:
        self._module.shared_event_publisher = self._original  # type: ignore[assignment]


class _broken_settings:  # noqa: N801 - a context manager used as a statement
    """Make `get_settings()` raise, as an incomplete environment does.

    Patched on `sqs_event_publisher`'s own reference so the failure happens where
    it does in production — inside `shared_event_publisher()`, beneath the
    command — and the real `shared_event_publisher` is exercised rather than
    replaced.
    """

    def __init__(self, error: Exception) -> None:
        self._error = error

    def __enter__(self) -> None:
        import src.shared.messaging.sqs_event_publisher as module

        self._module = module
        self._original = module.get_settings

        def raising() -> Any:
            raise self._error

        module.get_settings = raising  # type: ignore[assignment]

    def __exit__(self, *exc: Any) -> None:
        self._module.get_settings = self._original  # type: ignore[assignment]
