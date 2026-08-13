"""`http_errors_total` from `LogContextMiddleware` (JE-148, Task 7).

The middleware is the only place in this service that sees the FINAL status of
every response — including a 404 from Starlette's router, which no route handler
and no dependency ever runs for. That is why the counter lives there rather than
in a decorator or a dependency.

## Why these tests build their own app

They mount a two-route app rather than driving `create_app()`: what is under test
is the middleware's status observation, and the real app's routes need a database,
Cognito settings and a gRPC stub — none of which can make this assertion truer,
and all of which would make the test skip when Floci is down.

## The recorder is injected, never patched

`LogContextMiddleware` takes an optional `metrics` argument for exactly this. The
alternative — letting it fall through to `shared_metrics_publisher()` and patching
the module — would construct (or monkeypatch around) an `lru_cache`d boto3 client
inside a unit test, and an `lru_cache` keyed for the process would then leak the
patched publisher into every later test in the run.
"""

from __future__ import annotations

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from src.shared.http.log_context_middleware import LogContextMiddleware


class RecordingMetricsPublisher:
    """Keeps every `(name, value, dimensions)` triple verbatim."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, float, dict[str, str]]] = []

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        self.calls.append((name, value, dimensions))


async def _ok(request):  # noqa: ANN001, ANN202 - Starlette endpoint signature
    return JSONResponse({"status": "ok"})


async def _boom(request):  # noqa: ANN001, ANN202 - Starlette endpoint signature
    raise RuntimeError("boom")


def build_client(metrics: RecordingMetricsPublisher) -> TestClient:
    app = Starlette(routes=[Route("/ok", _ok), Route("/boom", _boom)])
    app.add_middleware(LogContextMiddleware, metrics=metrics)
    return TestClient(app, raise_server_exceptions=False)


def test_a_404_publishes_http_errors_total_with_status_class_4xx() -> None:
    metrics = RecordingMetricsPublisher()
    client = build_client(metrics)

    response = client.get("/no-such-route")

    assert response.status_code == 404
    assert metrics.calls == [
        ("http_errors_total", 1, {"Service": "tracking", "StatusClass": "4xx"})
    ]


def test_a_500_publishes_status_class_5xx() -> None:
    """The case a naive implementation misses.

    Starlette's ServerErrorMiddleware sends the 500 and then RE-RAISES the
    original exception, so a publish written after `await self.app(...)` never
    runs for precisely the responses a 5xx counter exists to count. This failed
    exactly that way before the publish moved into the `finally`.
    """
    metrics = RecordingMetricsPublisher()
    client = build_client(metrics)

    response = client.get("/boom")

    assert response.status_code == 500
    assert metrics.calls == [
        ("http_errors_total", 1, {"Service": "tracking", "StatusClass": "5xx"})
    ]


def test_a_200_publishes_nothing() -> None:
    """A metric per success would be a request-rate metric the logs already give."""
    metrics = RecordingMetricsPublisher()
    client = build_client(metrics)

    response = client.get("/ok")

    assert response.status_code == 200
    assert metrics.calls == []


def test_no_injected_publisher_does_not_change_the_response() -> None:
    """The metric is an observation of a response that already went out.

    With no publisher injected the middleware falls back to the process-wide one,
    which is gated on `METRICS_ENABLED` (the suite sets it false, per
    `conftest.py`) and, past that gate, guarded — its construction goes through
    `get_settings()`, which raises on the incomplete environment the whole REST
    suite runs with. Either way the response must be unaffected: a 404 that turns
    into a 500 because CloudWatch could not be reached is the exact failure the
    log-and-swallow policy exists to prevent.
    """
    app = Starlette(routes=[Route("/ok", _ok)])
    app.add_middleware(LogContextMiddleware)
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/no-such-route").status_code == 404


def test_an_unresolvable_publisher_is_swallowed_when_metrics_are_enabled(
    monkeypatch,  # noqa: ANN001 - pytest fixture
) -> None:
    """Past the METRICS_ENABLED gate, a publisher that cannot be built is swallowed.

    Forces the enabled path (the suite otherwise runs with the flag off) so the
    guard around `shared_metrics_publisher()` — not the gate in front of it — is
    what keeps the 404 a 404.
    """
    monkeypatch.setenv("METRICS_ENABLED", "true")

    app = Starlette(routes=[Route("/ok", _ok)])
    app.add_middleware(LogContextMiddleware)
    client = TestClient(app, raise_server_exceptions=False)

    assert client.get("/no-such-route").status_code == 404
