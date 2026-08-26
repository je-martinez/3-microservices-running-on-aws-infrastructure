"""`DELETE /v1/trackings/by-user` — the account-deletion cascade's Tracking leg."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from src.features.tracking.domain.models import Tracking
from tests.conftest import TEST_GRPC_API_KEY

pytestmark = pytest.mark.integration

PATH = "/v1/trackings/by-user"
#: Imported rather than restated, so the value the app is configured with and the
#: value these requests present cannot drift apart into a suite that passes for
#: the wrong reason.
KEY = TEST_GRPC_API_KEY


class TestInternalDeleteByUser:
    def test_rejects_a_request_with_no_key(self, client: TestClient) -> None:
        response = client.request(
            "DELETE", PATH, json={"cognito_sub": "s", "user_id": "u"}
        )
        assert response.status_code == 401

    def test_rejects_a_wrong_key(self, client: TestClient) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "s", "user_id": "u"},
            headers={"x-api-key": "wrong"},
        )
        assert response.status_code == 401

    def test_the_carrier_key_is_not_accepted_here(
        self, client: TestClient, carrier_key: str
    ) -> None:
        """The two inbound keys are different credentials.

        They must never be interchangeable: accepting the carrier's key here would
        let an outside vendor erase a user's delivery history.
        """
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "s", "user_id": "u"},
            headers={"x-api-key": carrier_key},
        )
        assert response.status_code == 401

    def test_soft_deletes_the_users_trackings(
        self, client: TestClient, seeded_tracking: Tracking
    ) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={
                "cognito_sub": seeded_tracking.cognito_sub,
                "user_id": seeded_tracking.user_id,
            },
            headers={"x-api-key": KEY},
        )
        assert response.status_code == 200
        assert response.json() == {"deleted": 1}

    def test_is_idempotent(
        self, client: TestClient, seeded_tracking: Tracking
    ) -> None:
        body = {
            "cognito_sub": seeded_tracking.cognito_sub,
            "user_id": seeded_tracking.user_id,
        }
        client.request("DELETE", PATH, json=body, headers={"x-api-key": KEY})
        second = client.request("DELETE", PATH, json=body, headers={"x-api-key": KEY})

        assert second.status_code == 200
        assert second.json() == {"deleted": 0}

    def test_rejects_an_empty_identity(self, client: TestClient) -> None:
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "", "user_id": ""},
            headers={"x-api-key": KEY},
        )
        assert response.status_code == 422

    def test_the_route_does_not_shadow_the_order_id_read(
        self, client: TestClient
    ) -> None:
        """`/by-user` is literal; `GET /v1/trackings/{order_id}` must still resolve."""
        response = client.get("/v1/trackings/by-user", headers={"x-user-id": "sub-x"})
        # Reaches the read route (404 for an unknown order), not the internal DELETE.
        assert response.status_code in (401, 404)
