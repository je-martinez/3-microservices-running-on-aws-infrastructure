"""The user-scoped REST reads (JE-93), against the REAL app and a REAL MySQL.

    GET /v1/trackings/{order_id}
    GET /v1/trackings?order_ids=a,b,c

The centre of gravity here is **ownership**, not plumbing. The design's rule is
that a tracking belonging to another user must be indistinguishable from one that
does not exist — `404`, never `403`, on the single read; silently omitted on the
batch read. Those two tests (`TestOwnership`) are the security property this
endpoint exists to hold, so they are written as an explicit two-user setup: create
as user A, read as user B.

Everything goes through the app rather than calling the query functions directly,
because the scoping is only correct if the HANDLER passes the caller's id — a
direct call to `get_my_tracking_by_order_id` would prove the query filters and
prove nothing about whether the endpoint uses it.

## The two identities

Every tracking here is seeded with BOTH a `usr_` id and a Cognito sub, and they are
deliberately different strings, because that is the situation in production: the
row's `user_id` is the internal `usr_` id resolved through Users at creation, while
the gateway hands this service the JWT's `sub` in `x-user-id`. A fixture that used
one value for both would make the
whole suite pass against a service scoped by the wrong column — which is exactly
how the original defect survived 253 tests.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.domain.status import TrackingStatus
from src.shared.audit.audit_actor import AuditActor

pytestmark = pytest.mark.integration

# The INTERNAL ids, as resolved through Users at creation time.
USER_A = "usr_aaaaaaaaaaaaaaaaaaaaa"
USER_B = "usr_bbbbbbbbbbbbbbbbbbbbb"

# The Cognito subs the GATEWAY injects as `x-user-id` for those same two people.
# Intentionally nothing like the `usr_` ids above: a caller presents one of these,
# never one of those, and the tests must not be able to confuse them.
SUB_A = "11111111-1111-4111-8111-111111111111"
SUB_B = "22222222-2222-4222-8222-222222222222"

ADDRESS = {
    "line1": "742 Evergreen Terrace",
    "city": "Springfield",
    "country": "US",
    "postal_code": "97477",
}


def seed(
    session: Session,
    *,
    order_id: str,
    user_id: str = USER_A,
    cognito_sub: str | None = SUB_A,
    status: TrackingStatus = TrackingStatus.SHIPPED,
) -> str:
    """Create a committed tracking and return its id.

    Committed, not merely flushed: the request under test runs on its own session,
    so an uncommitted row would be invisible to it and every test would 404 for the
    wrong reason.
    """
    repo = TrackingRepository(session)
    tracking = repo.create(
        order_id=order_id,
        user_id=user_id,
        cognito_sub=cognito_sub,
        shipping_address=ADDRESS,
        status=status,
        actor=AuditActor.CREATE_TRACKING,
    )
    session.commit()
    return tracking.id


def as_user(cognito_sub: str) -> dict[str, str]:
    """The gateway-injected identity header — it holds a Cognito SUB, not a usr_ id."""
    return {"x-user-id": cognito_sub}


class TestSingleReadAuth:
    """`x-user-id` is the credential; without it there is no request to serve."""

    def test_missing_header_is_401(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_auth00000000000001")
        response = client.get("/v1/trackings/ord_auth00000000000001")
        assert response.status_code == 401

    def test_empty_header_is_401_too(
        self, client: TestClient, session: Session
    ) -> None:
        """nginx sets the header to "" on a missing/malformed token rather than
        omitting it — accepting "" would scope the read to `user_id = ''` and
        return an empty 200 instead of a 401."""
        seed(session, order_id="ord_auth00000000000002")
        response = client.get(
            "/v1/trackings/ord_auth00000000000002", headers=as_user("")
        )
        assert response.status_code == 401

    def test_401_is_returned_before_the_tracking_is_looked_up(
        self, client: TestClient
    ) -> None:
        """An unauthenticated request for a NON-existent id also 401s, not 404s —
        proving the auth dependency runs first and the endpoint leaks nothing about
        what exists to a caller who has not identified themselves."""
        response = client.get("/v1/trackings/ord_does00000000000001")
        assert response.status_code == 401


class TestSingleRead:
    def test_returns_the_callers_own_tracking(
        self, client: TestClient, session: Session
    ) -> None:
        tracking_id = seed(session, order_id="ord_read00000000000001")
        response = client.get(
            "/v1/trackings/ord_read00000000000001", headers=as_user(SUB_A)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["id"] == tracking_id
        assert body["order_id"] == "ord_read00000000000001"
        assert body["user_id"] == USER_A
        assert body["status"] == TrackingStatus.SHIPPED

    def test_includes_the_history(
        self, client: TestClient, session: Session
    ) -> None:
        """The design says "one tracking + its `Tracking_History`" — a bare
        tracking would be an incomplete payload."""
        seed(session, order_id="ord_read00000000000002")
        body = client.get(
            "/v1/trackings/ord_read00000000000002", headers=as_user(SUB_A)
        ).json()
        assert [entry["status"] for entry in body["history"]] == [
            TrackingStatus.SHIPPED
        ]

    def test_datetime_is_iso_8601_with_an_explicit_z(
        self, client: TestClient, session: Session
    ) -> None:
        """The columns are naive UTC, so a bare `isoformat()` would emit no offset
        and leave the client guessing which zone it is in."""
        seed(session, order_id="ord_read00000000000003")
        body = client.get(
            "/v1/trackings/ord_read00000000000003", headers=as_user(SUB_A)
        ).json()
        assert body["datetime"].endswith("Z")
        assert body["history"][0]["datetime"].endswith("Z")

    def test_never_exposes_the_shipping_address(
        self, client: TestClient, session: Session
    ) -> None:
        """PII. The row HAS one (seed stores it), so this proves the schema omits
        it rather than the fixture happening not to set it.

        Asserted against the RAW response text, not just the top-level keys: the
        address must not appear anywhere in the payload, including nested inside a
        history entry.
        """
        seed(session, order_id="ord_read00000000000004")
        response = client.get(
            "/v1/trackings/ord_read00000000000004", headers=as_user(SUB_A)
        )
        assert "shipping_address" not in response.json()
        assert "Evergreen" not in response.text

    def test_never_exposes_audit_or_soft_delete_columns(
        self, client: TestClient, session: Session
    ) -> None:
        """Internal columns; the response model is a contract, not a row dump."""
        seed(session, order_id="ord_read00000000000005")
        body = client.get(
            "/v1/trackings/ord_read00000000000005", headers=as_user(SUB_A)
        ).json()
        for internal in ("created_by", "created_at", "updated_by", "deleted_at"):
            assert internal not in body

    def test_unknown_order_id_is_404(self, client: TestClient) -> None:
        response = client.get(
            "/v1/trackings/ord_nothing000000000001", headers=as_user(SUB_A)
        )
        assert response.status_code == 404


class TestOwnership:
    """THE security property. A tracking you do not own must look like one that
    does not exist."""

    def test_another_users_tracking_is_404_not_403(
        self, client: TestClient, session: Session
    ) -> None:
        """Created as user A, read as user B.

        `403` would confirm that a tracking exists for that order id and turn the
        endpoint into an oracle for other people's order ids — which is exactly
        what a caller enumerating ids would use.
        """
        seed(session, order_id="ord_owned0000000000001", user_id=USER_A)

        response = client.get(
            "/v1/trackings/ord_owned0000000000001", headers=as_user(SUB_B)
        )

        assert response.status_code == 404
        assert response.status_code != 403

    def test_the_404_is_byte_identical_to_a_missing_tracking(
        self, client: TestClient, session: Session
    ) -> None:
        """Indistinguishable, not merely "also a 404".

        A different `detail` string between the two cases would leak exactly the
        fact the 404 exists to hide.
        """
        seed(session, order_id="ord_owned0000000000002", user_id=USER_A)

        not_yours = client.get(
            "/v1/trackings/ord_owned0000000000002", headers=as_user(SUB_B)
        )
        not_there = client.get(
            "/v1/trackings/ord_absent000000000001", headers=as_user(SUB_B)
        )

        assert not_yours.status_code == not_there.status_code == 404
        assert not_yours.json() == not_there.json()

    def test_the_owner_still_sees_it(
        self, client: TestClient, session: Session
    ) -> None:
        """The other half of the property: scoping must not 404 the legitimate
        owner. Without this, a handler that always 404s would pass every test
        above."""
        seed(session, order_id="ord_owned0000000000003", user_id=USER_A)
        assert (
            client.get(
                "/v1/trackings/ord_owned0000000000003", headers=as_user(SUB_A)
            ).status_code
            == 200
        )


class TestScopeIsTheCognitoSubNotTheUserId:
    """The regression guard for the identity defect these reads shipped with.

    `tracking.user_id` holds the internal `usr_` id resolved through Users, while
    the gateway hands this service the JWT's `sub` in `x-user-id`
    (`proxy_set_header x-user-id $jwt_sub`). Scoping the reads by `user_id`
    therefore compared a sub against a `usr_` id and matched NOTHING — every
    user-scoped read 404'd, the caller's own tracking included.

    The 253 tests that existed before this class did not catch it because they
    created and read with the SAME value. Every test here uses two values that
    cannot be confused, which is the only shape that can fail on the bug.
    """

    def test_the_owner_reads_their_tracking_by_presenting_their_sub(
        self, client: TestClient, session: Session
    ) -> None:
        """The test that fails on the unfixed service.

        Created with user_id=usr_X and cognito_sub=sub_X; read by a caller
        presenting `x-user-id: sub_X`. Against a service scoped by `user_id` this
        is a 404.
        """
        seed(
            session,
            order_id="ord_ident000000000001",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        response = client.get(
            "/v1/trackings/ord_ident000000000001", headers=as_user(SUB_A)
        )

        assert response.status_code == 200
        assert response.json()["order_id"] == "ord_ident000000000001"
        # The row still carries the internal id — both identities are persisted.
        assert response.json()["user_id"] == USER_A

    def test_a_different_users_sub_still_gets_404(
        self, client: TestClient, session: Session
    ) -> None:
        """The other half: `sub_Y` must NOT read `sub_X`'s tracking.

        Without this, "scope by nothing at all" would pass the test above.
        """
        seed(
            session,
            order_id="ord_ident000000000002",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        response = client.get(
            "/v1/trackings/ord_ident000000000002", headers=as_user(SUB_B)
        )

        assert response.status_code == 404

    def test_presenting_the_internal_user_id_is_404(
        self, client: TestClient, session: Session
    ) -> None:
        """A caller who somehow presents the `usr_` id gets nothing.

        This pins the direction of the fix: the scope is the sub, so the internal
        id is not an alternative key that also works. If both matched, a later
        change could quietly go back to filtering on `user_id` and stay green.
        """
        seed(
            session,
            order_id="ord_ident000000000003",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        response = client.get(
            "/v1/trackings/ord_ident000000000003", headers=as_user(USER_A)
        )

        assert response.status_code == 404

    def test_the_batch_read_is_scoped_by_the_sub_too(
        self, client: TestClient, session: Session
    ) -> None:
        """The batch read shares the defect and therefore shares the guard."""
        seed(
            session,
            order_id="ord_ident000000000004",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        body = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_ident000000000004"},
            headers=as_user(SUB_A),
        ).json()

        assert [t["order_id"] for t in body["trackings"]] == [
            "ord_ident000000000004"
        ]

    def test_the_batch_read_omits_it_for_the_internal_user_id(
        self, client: TestClient, session: Session
    ) -> None:
        seed(
            session,
            order_id="ord_ident000000000005",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        body = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_ident000000000005"},
            headers=as_user(USER_A),
        ).json()

        assert body == {"trackings": []}

    def test_a_tracking_created_without_a_sub_is_unreachable_not_mis_attributed(
        self, client: TestClient, session: Session
    ) -> None:
        """An older caller's row (NULL `cognito_sub`) 404s for everyone.

        The important half is that it is not readable by SOMEONE — a fallback like
        "if cognito_sub is NULL, match on user_id" would hand it to whoever
        presented that string. NULL matching nothing is the safe direction.
        """
        seed(
            session,
            order_id="ord_ident000000000006",
            user_id=USER_A,
            cognito_sub=None,
        )

        for header in (SUB_A, SUB_B, USER_A):
            assert (
                client.get(
                    "/v1/trackings/ord_ident000000000006", headers=as_user(header)
                ).status_code
                == 404
            )

    def test_the_response_never_leaks_the_cognito_sub(
        self, client: TestClient, session: Session
    ) -> None:
        """The sub stays server-side. It identifies the caller in the auth system
        and adds nothing to a shipment status view, so the narrowest surface that
        answers the question is the one that omits it — the same reasoning that
        keeps `shipping_address` out of this schema."""
        seed(
            session,
            order_id="ord_ident000000000007",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        response = client.get(
            "/v1/trackings/ord_ident000000000007", headers=as_user(SUB_A)
        )

        assert "cognito_sub" not in response.text
        assert SUB_A not in response.text


class TestBatchRead:
    def test_missing_header_is_401(self, client: TestClient) -> None:
        response = client.get("/v1/trackings", params={"order_ids": "ord_x"})
        assert response.status_code == 401

    def test_returns_each_owned_tracking_with_its_history(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_batch0000000000001")
        seed(session, order_id="ord_batch0000000000002")

        body = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_batch0000000000001,ord_batch0000000000002"},
            headers=as_user(SUB_A),
        ).json()

        assert {t["order_id"] for t in body["trackings"]} == {
            "ord_batch0000000000001",
            "ord_batch0000000000002",
        }
        assert all(len(t["history"]) == 1 for t in body["trackings"])

    def test_omits_non_owned_ids_without_erroring(
        self, client: TestClient, session: Session
    ) -> None:
        """The batch equivalent of the single read's 404.

        User B asks for one id they own and one user A owns. They get one tracking
        and a `200` — no per-id error entry, no partial-failure flag, nothing that
        would tell them the other id exists.
        """
        seed(
            session,
            order_id="ord_mine00000000000001",
            user_id=USER_B,
            cognito_sub=SUB_B,
        )
        seed(
            session,
            order_id="ord_theirs000000000001",
            user_id=USER_A,
            cognito_sub=SUB_A,
        )

        response = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_mine00000000000001,ord_theirs000000000001"},
            headers=as_user(SUB_B),
        )

        assert response.status_code == 200
        body = response.json()
        assert [t["order_id"] for t in body["trackings"]] == [
            "ord_mine00000000000001"
        ]
        # Nothing anywhere in the payload hints at the id that was filtered out.
        assert "ord_theirs000000000001" not in response.text

    def test_unknown_ids_are_omitted_the_same_way(
        self, client: TestClient, session: Session
    ) -> None:
        """A non-existent id and a non-owned one are handled identically — which is
        what makes the two indistinguishable."""
        seed(session, order_id="ord_batch0000000000003")

        body = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_batch0000000000003,ord_nope00000000000001"},
            headers=as_user(SUB_A),
        ).json()

        assert [t["order_id"] for t in body["trackings"]] == [
            "ord_batch0000000000003"
        ]

    def test_all_missing_is_an_empty_200_not_a_404(
        self, client: TestClient
    ) -> None:
        """"None of these are yours" is a complete answer, not a failure."""
        response = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_none00000000000001,ord_none00000000000002"},
            headers=as_user(SUB_A),
        )
        assert response.status_code == 200
        assert response.json() == {"trackings": []}

    def test_blank_and_duplicate_ids_are_tolerated(
        self, client: TestClient, session: Session
    ) -> None:
        """`?order_ids=a,,a` is a sloppy caller, not an error — the question is
        still well defined, and the answer must not double up."""
        seed(session, order_id="ord_batch0000000000004")

        body = client.get(
            "/v1/trackings",
            params={
                "order_ids": "ord_batch0000000000004,,ord_batch0000000000004"
            },
            headers=as_user(SUB_A),
        ).json()

        assert len(body["trackings"]) == 1

    def test_order_ids_is_required(self, client: TestClient) -> None:
        """Without it there is no question to answer; FastAPI rejects at 422."""
        response = client.get("/v1/trackings", headers=as_user(SUB_A))
        assert response.status_code == 422

    def test_too_many_ids_is_400(self, client: TestClient) -> None:
        """`order_ids` lands in a `WHERE order_id IN (...)`; unbounded input lets
        one request build an arbitrarily large query."""
        too_many = ",".join(f"ord_{index:021d}" for index in range(101))
        response = client.get(
            "/v1/trackings",
            params={"order_ids": too_many},
            headers=as_user(SUB_A),
        )
        assert response.status_code == 400

    def test_never_exposes_the_shipping_address(
        self, client: TestClient, session: Session
    ) -> None:
        seed(session, order_id="ord_batch0000000000005")
        response = client.get(
            "/v1/trackings",
            params={"order_ids": "ord_batch0000000000005"},
            headers=as_user(SUB_A),
        )
        assert "Evergreen" not in response.text
        assert "shipping_address" not in response.text
