"""The app factory: what the process actually serves (Phase D wiring).

These do not need a database — the routing table is a process fact. Deliberately
NOT marked `integration` so they still run when no MySQL is reachable, which is
when a wiring mistake is most likely to go unnoticed.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.main import create_app


def routes(app: FastAPI) -> set[tuple[str, str]]:
    """(method, path) pairs for the app's real endpoints."""
    found: set[tuple[str, str]] = set()
    for route in app.routes:
        methods = getattr(route, "methods", None)
        path = getattr(route, "path", None)
        if methods and path and not path.startswith(("/docs", "/openapi", "/redoc")):
            found.update((method, path) for method in methods if method != "HEAD")
    return found


class TestRoutingTable:
    """Every REST endpoint, at the path the gateway expects."""

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("GET", "/v1/health"),
            ("POST", "/v1/trackings/init-tracking"),
            ("GET", "/v1/trackings"),
            ("GET", "/v1/trackings/{order_id}"),
            ("PUT", "/v1/trackings/{order_id}/status"),
        ],
    )
    def test_endpoint_is_registered(self, method: str, path: str) -> None:
        assert (method, path) in routes(create_app())

    def test_creation_is_the_only_post(self) -> None:
        """Exactly one POST on this surface, and it is `init-tracking` (JE-105).

        This test used to assert the OPPOSITE — that no REST creation endpoint
        existed at all, because creation was gRPC-only. JE-105 inverted that and
        JE-108 removed the RPC, so this is now the ONLY way a tracking is created.
        Pinning the count rather than merely the presence keeps a second,
        unreviewed write surface from appearing beside it.
        """
        posts = [path for method, path in routes(create_app()) if method == "POST"]
        assert posts == ["/v1/trackings/init-tracking"]

    def test_creation_is_not_at_the_bare_collection_path(self) -> None:
        """`POST /v1/trackings` is NOT the route — `/init-tracking` is.

        The spelling is a gateway contract, not a REST-style preference: the route
        published by the API Gateway is `POST /v1/trackings/init-tracking`, and a
        service listening on the collection path instead would 404 every real call
        while looking implemented locally.
        """
        assert ("POST", "/v1/trackings") not in routes(create_app())

    def test_the_only_default_delete_is_the_internal_cascade(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Soft-delete-only: no USER-FACING route removes a tracking.

        This used to assert the default surface carried no `DELETE` at all. The
        account-deletion cascade (`DELETE /v1/trackings/by-user`) made that literal
        form false while leaving the property it protected intact, so the assertion
        is narrowed rather than dropped: the surface may carry exactly this one
        DELETE, it is INTERNAL (absent from the API Gateway, authenticated with the
        shared service key, never a user JWT), and any second one is a regression
        to review. Listing it by name is what keeps a new DELETE from arriving
        unnoticed under a relaxed rule.

        `DELETE` here is the HTTP method, never a SQL one — the handler stamps
        `deleted_at` / `deleted_by`, and the database user has no DELETE grant.

        The flag is explicitly cleared rather than assumed absent — a developer
        with `E2E_TESTING_ENABLED=true` exported would otherwise see this fail for
        a reason that has nothing to do with the change under test. The E2E
        cleanup route's own gating is covered in `test_rest_e2e_cleanup.py`.
        """
        monkeypatch.delenv("E2E_TESTING_ENABLED", raising=False)
        deletes = {path for method, path in routes(create_app()) if method == "DELETE"}
        assert deletes == {"/v1/trackings/by-user"}


class TestHttpIsTheOnlyServedTransport:
    """Tracking serves REST and nothing else (JE-108).

    The gRPC server this app used to start from its lifespan is gone: creation is
    `POST /v1/trackings/init-tracking` and the two unscoped reads were replaced by
    the user-scoped REST ones. What remains gRPC in this service points OUTWARD,
    to Users, and needs no server and no startup hook.
    """

    def test_the_app_starts_and_serves_without_binding_anything_else(self) -> None:
        """Startup binds no second port, so two apps can run side by side.

        Used as a context manager on purpose — that is what runs startup/shutdown.
        Before JE-108 this same call bound `GRPC_PORT` unless a flag said otherwise,
        which is why the REST suite had to set one.
        """
        with TestClient(create_app()) as client:
            assert client.get("/v1/health").status_code == 200

        # A second app, immediately after, over the same defaults. This is the
        # assertion the old flag existed to make unnecessary.
        with TestClient(create_app()) as client:
            assert client.get("/v1/health").status_code == 200

    def test_the_app_registers_no_startup_or_shutdown_handlers(self) -> None:
        """Nothing to start, nothing to stop.

        Starlette records both `lifespan`-context work and legacy `on_event`
        handlers on the router, so this covers either spelling of "something runs
        at startup".
        """
        app = create_app()
        assert app.router.on_startup == []
        assert app.router.on_shutdown == []

    def test_nothing_under_src_imports_a_grpc_server(self) -> None:
        """The served surface is gone from the source tree, not merely unwired.

        A `shared/grpc/server.py` left behind and simply not called would be
        re-enabled by one line, and would still carry the inbound `x-api-key`
        interceptor this service no longer has any use for.
        """
        from pathlib import Path

        src_root = Path(__file__).resolve().parents[1] / "src"
        assert not (src_root / "shared" / "grpc" / "server.py").exists()
        assert not (src_root / "shared" / "grpc" / "api_key_interceptor.py").exists()
        assert not (src_root / "features" / "tracking" / "grpc").exists()

        offenders = [
            str(path.relative_to(src_root))
            for path in src_root.rglob("*.py")
            if "tracking_pb2" in path.read_text()
        ]
        assert not offenders, f"tracking stubs still referenced by {offenders}"
