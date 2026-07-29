"""The app factory and the gRPC-alongside-HTTP lifespan (Phase D wiring).

These do not need a database — the routing table and the lifespan are process
facts. Deliberately NOT marked `integration` so they still run when no MySQL is
reachable, which is when a wiring mistake is most likely to go unnoticed.

The gRPC test uses a fake `serve()` rather than a real server: what matters is that
the lifespan STARTS one on startup and STOPS it on shutdown, and binding a real
port here would collide with the gRPC suite and with a locally-running service.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.main import GRPC_ENABLED_ENV, create_app


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
        existed at all, because creation was gRPC-only. JE-105 inverted that: the
        endpoint is now the way a tracking is created, and the gRPC RPC is what goes
        away (JE-108). Pinning the count rather than merely the presence keeps a
        second, unreviewed write surface from appearing beside it.
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

    def test_no_delete_endpoint_exists(self) -> None:
        """Soft-delete-only: nothing on this surface removes a tracking."""
        assert not any(
            method == "DELETE" for method, _ in routes(create_app())
        )


class TestGrpcLifespan:
    """gRPC and HTTP in one process, via the non-blocking `serve()` seam."""

    def test_lifespan_starts_and_stops_the_grpc_server(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        started: list[str] = []
        stopped: list[str] = []

        class FakeServer:
            def stop(self, grace: float | None = None):
                stopped.append("stopped")

                class _Event:
                    def wait(self) -> None:
                        return None

                return _Event()

        def fake_serve():
            started.append("started")
            return FakeServer()

        import src.shared.grpc.server as grpc_server_module

        monkeypatch.setenv(GRPC_ENABLED_ENV, "1")
        monkeypatch.setattr(grpc_server_module, "serve", fake_serve)

        with TestClient(create_app()) as client:
            assert started == ["started"]
            # HTTP is serving WHILE the gRPC server is up — the whole point of the
            # non-blocking `serve()`: a blocking `serve_forever()` here would never
            # have let the app finish starting.
            assert client.get("/v1/health").status_code == 200
            assert stopped == []

        assert stopped == ["stopped"]

    def test_the_flag_can_disable_the_grpc_server(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The escape hatch the HTTP test suite relies on — without it, every REST
        test would try to bind GRPC_PORT."""
        calls: list[str] = []

        import src.shared.grpc.server as grpc_server_module

        monkeypatch.setenv(GRPC_ENABLED_ENV, "0")
        monkeypatch.setattr(
            grpc_server_module, "serve", lambda: calls.append("started")
        )

        with TestClient(create_app()) as client:
            assert client.get("/v1/health").status_code == 200

        assert calls == []

    def test_serve_forever_is_not_used_by_the_app(self) -> None:
        """`serve_forever()` blocks and exists only for the standalone gRPC
        entrypoint. If `main.py` ever called it, uvicorn would never start."""
        from pathlib import Path

        source = Path(__file__).resolve().parents[1] / "src" / "main.py"
        assert "serve_forever" not in source.read_text().split('"""')[-1]
