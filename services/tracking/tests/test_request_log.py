"""The per-request `request completed` line from `LogContextMiddleware`.

Tracking was the only HTTP service emitting no request log, so `http_route` and
`duration_ms` were absent from every record it produced and its dashboard could
show neither request rate, nor latency, nor top routes. The line lives in the
middleware because that is the only layer seeing the final status of EVERY
request — including a 404 the router answers with no handler and no dependency
run, and a 500 raised out of a handler.

## The field names are a contract, not a preference

`http_request_method`, `http_route`, `http_response_status_code`, `duration_ms`
and the exact message `request completed` are what Users already emits (its
Fastify `onResponse` hook) and what the dashboards query literally. A test that
only asserted "some line was logged" would pass against a record no dashboard
can select on, so each assertion names the field.

## Why a FastAPI app rather than the Starlette one in test_http_error_metrics.py

`scope["route"]` is set by **FastAPI's** `APIRoute.matches`, not by Starlette's
`Route` — a plain Starlette app leaves it absent and every route would fall back
to the raw path, which is exactly the bug these tests exist to catch. The routes
are declared here rather than driving `create_app()` because the real ones need a
database, Cognito settings and a gRPC stub, none of which make the assertion
truer and all of which would make this skip when Floci is down.

## Health checks are the one exemption, and only while they succeed

A successful `GET /v1/health` is NOT logged; a failing one is. This file used to
assert the opposite, on the reasoning that a probe which starts failing is worth
seeing and an exemption list is one more thing to keep correct — both still true,
and neither requires logging the successes. What changed it was the ratio: 353 of
this service's 368 lines in an hour were that one request at 200, against 2 lines
describing actual tracking work. The pair of tests below is the contract; testing
only the exemption would let a change that silences the route entirely pass.

## `http_route` is the TEMPLATE

The parameterised route is requested with a concrete id and asserted to log
`/v1/trackings/{order_id}`. Logging the raw URL would give every order id its own
"route" and destroy the field's groupability; asserting the templated form is the
only assertion that can fail on that.
"""

from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.shared.http.log_context_middleware import LogContextMiddleware

MIDDLEWARE_LOGGER = "src.shared.http.log_context_middleware"


@pytest.fixture
def client() -> TestClient:
    """A two-route app plus a health check, wrapped in the middleware alone."""
    app = FastAPI()

    @app.get("/v1/trackings/{order_id}")
    async def read(order_id: str) -> dict[str, str]:  # noqa: ANN202 - fixture route
        return {"order_id": order_id}

    @app.get("/v1/health")
    async def health() -> dict[str, str]:  # noqa: ANN202 - fixture route
        return {"status": "ok"}

    @app.get("/boom")
    async def boom() -> dict[str, str]:  # noqa: ANN202 - fixture route
        raise RuntimeError("boom")

    app.add_middleware(LogContextMiddleware)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def failing_health_client() -> TestClient:
    """An app whose health route FAILS, to prove the exemption is status-scoped.

    A separate fixture rather than a flag on the one above: the exemption turns
    on the response status, so the only honest way to test the failing branch is
    a route that really returns one.
    """
    app = FastAPI()

    @app.get("/v1/health")
    async def health() -> dict[str, str]:  # noqa: ANN202 - fixture route
        raise RuntimeError("probe down")

    app.add_middleware(LogContextMiddleware)
    return TestClient(app, raise_server_exceptions=False)


def request_lines(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    """Every `request completed` record, in order."""
    return [r for r in caplog.records if r.getMessage() == "request completed"]


def only_line(caplog: pytest.LogCaptureFixture) -> logging.LogRecord:
    """The single request line, asserting there is exactly one.

    One line per request is part of the contract: a duplicate would double every
    rate and latency figure computed from it.
    """
    lines = request_lines(caplog)
    assert len(lines) == 1, f"expected exactly one request line, got {len(lines)}"
    return lines[0]


class TestASuccessfulRequestIsLogged:
    def test_a_2xx_emits_the_line_with_all_five_fields(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The whole contract in one assertion set.

        `http_route` is the TEMPLATE even though the request carried a concrete
        order id — the field is grouped on in the dashboard, so a raw URL would
        make every order its own route.
        """
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get("/v1/trackings/ord_abc123")

        assert response.status_code == 200

        record = only_line(caplog)
        assert record.levelno == logging.INFO
        assert record.http_request_method == "GET"
        assert record.http_route == "/v1/trackings/{order_id}"
        assert record.http_response_status_code == 200
        assert isinstance(record.duration_ms, float)
        assert record.duration_ms >= 0

    def test_the_route_is_never_the_concrete_url(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The cardinality guard, stated as its own failure.

        Pinned separately from the field-contract test above so a regression to
        the raw path fails with an unambiguous message rather than as one
        assertion inside a five-field comparison.
        """
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get("/v1/trackings/ord_abc123")

        assert "ord_abc123" not in only_line(caplog).http_route


class TestFailuresAreLoggedToo:
    def test_a_4xx_carries_the_right_status(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A 404 is answered by the router, with no handler and no dependency run.

        Severity stays INFO: the status code carries the outcome, matching Users.
        An error rate computed from `severity_text` and one computed from
        `http_response_status_code` must not disagree.
        """
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get("/v1/no-such-route")

        assert response.status_code == 404

        record = only_line(caplog)
        assert record.http_response_status_code == 404
        assert record.levelno == logging.INFO
        # Nothing matched, so there is no template to log — the raw path is the
        # documented fallback rather than a missing field.
        assert record.http_route == "/v1/no-such-route"

    def test_a_handler_that_raises_still_emits_the_line(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The case a naive implementation misses.

        Starlette's ServerErrorMiddleware sits OUTSIDE this middleware, so the
        exception passes through here before that 500 response exists — a log
        written only after `await self.app(...)` never runs for precisely the
        requests most worth a line. The status is asserted as 500 because that is
        what the client ends up receiving.
        """
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get("/boom")

        assert response.status_code == 500

        record = only_line(caplog)
        assert record.http_response_status_code == 500
        assert record.http_route == "/boom"
        assert record.http_request_method == "GET"


class TestTheLogNeverBreaksTheRequest:
    def test_a_logger_that_raises_does_not_fail_the_response(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Same stance as the metric below it: an observation of a response that
        already went out must never become an error of its own.

        `logger.info` is forced to raise; the response must be unaffected.
        """
        import src.shared.http.log_context_middleware as middleware

        def explode(*args: object, **kwargs: object) -> None:
            raise RuntimeError("logging is down")

        monkeypatch.setattr(middleware.logger, "info", explode)

        response = client.get("/v1/trackings/ord_abc123")

        assert response.status_code == 200


class TestHealthChecksAreExemptOnlyWhileTheySucceed:
    """The liveness probe's 2xx responses are not logged; its failures are.

    This pair is the whole contract. Testing only the first half would let a
    change that silences the route ENTIRELY pass — which is the outcome the
    exemption was deliberately designed to avoid, since a probe that starts
    failing is the one health line worth having.
    """

    def test_a_successful_probe_is_not_logged(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """353 of 368 lines in an hour were this exact request. It carries no
        information a healthy container does not already convey."""
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = client.get("/v1/health")

        assert response.status_code == 200
        assert request_lines(caplog) == []

    def test_a_failing_probe_is_logged(
        self, failing_health_client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The case the exemption exists to preserve: status and duration are
        exactly what explains a probe that started failing."""
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            response = failing_health_client.get("/v1/health")

        assert response.status_code == 500
        record = only_line(caplog)
        assert record.http_route == "/v1/health"
        assert record.http_response_status_code == 500

    def test_other_routes_are_still_logged(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The exemption is scoped to the health route, not to 2xx in general."""
        with caplog.at_level(logging.INFO, logger=MIDDLEWARE_LOGGER):
            client.get("/v1/trackings/ord_abc123")

        assert only_line(caplog).http_response_status_code == 200
