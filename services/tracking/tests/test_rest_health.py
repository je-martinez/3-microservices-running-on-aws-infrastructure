"""`GET /v1/health` (JE-92).

Drives the REAL app through `TestClient`. The suite is short because the endpoint
is, but two of these tests guard real failure modes: the exact body (which ALB /
Fargate probes and the gateway contract depend on) and the absence of any auth
requirement (the probe carries neither an `x-user-id` nor an API key, so a handler
that grew one would take the service out of rotation while looking fine locally).
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

pytestmark = pytest.mark.integration


class TestHealth:
    def test_returns_200_without_any_credential(self, client: TestClient) -> None:
        """No `x-user-id`, no `x-api-key`, no JWT — exactly what a probe sends."""
        response = client.get("/v1/health")
        assert response.status_code == 200

    def test_body_is_status_ok(self, client: TestClient) -> None:
        """The exact payload the design specifies."""
        assert client.get("/v1/health").json() == {"status": "ok"}

    def test_is_served_unprefixed(self, client: TestClient) -> None:
        """The SERVICE serves the bare path; the gateway publishes the prefixed one.

        nginx rewrites `/v1/tracking/health` down to this. The prefixed path must
        NOT also exist here — if it did, the rewrite and the direct path could
        drift apart and a probe could pass against a route nobody maintains.
        """
        assert client.get("/v1/tracking/health").status_code == 404

    def test_an_x_user_id_is_ignored_not_required(self, client: TestClient) -> None:
        """Sending one changes nothing — the endpoint has no identity at all."""
        response = client.get("/v1/health", headers={"x-user-id": "usr_whoever"})
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
