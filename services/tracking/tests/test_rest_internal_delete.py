"""`DELETE /v1/trackings/by-user` — the account-deletion cascade's Tracking leg."""

from __future__ import annotations

import logging
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind

from src.features.tracking.domain.models import Tracking
from src.shared.logging.context_filter import LogContextFilter
from src.shared.observability import workflow_tracing
from tests.conftest import TEST_GRPC_API_KEY

pytestmark = pytest.mark.integration

PATH = "/v1/trackings/by-user"
#: Imported rather than restated, so the value the app is configured with and the
#: value these requests present cannot drift apart into a suite that passes for
#: the wrong reason.
KEY = TEST_GRPC_API_KEY

#: The two loggers this route emits from. The auth failure is logged by the
#: dependency, the flow triad by the handler — asserting on the wrong one is how a
#: missing line reads as a passing test.
ROUTER_LOGGER = "src.features.tracking.api.internal_router"
AUTH_LOGGER = "src.shared.http.internal_auth"


def flow_lines(
    caplog: pytest.LogCaptureFixture, app_event: str
) -> list[logging.LogRecord]:
    """Records carrying `app_event`, read off the RECORD's attributes.

    Not off the rendered message: `extra=` fields are what the JSON formatter
    emits, and a substring match on the message would pass for a line that carried
    no fields at all.
    """
    return [
        record
        for record in caplog.records
        if getattr(record, "app_event", None) == app_event
    ]


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


@pytest.fixture
def exporter(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    """A private tracer provider, wired into `workflow_tracing` only.

    `trace.set_tracer_provider` is a one-shot global — a second call is ignored
    with a warning — so swapping the module's tracer for the duration of a test
    leaves the global untouched and keeps this file runnable in any order
    alongside the rest of the suite. Same shape as `test_workflow_tracing.py`.
    """
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    monkeypatch.setattr(
        workflow_tracing, "_tracer", provider.get_tracer("tracking-workflow")
    )
    yield memory
    memory.clear()


class TestFlowLogging:
    """The `app_event` triad, and the identities that make a line joinable.

    This is a WRITE — and a mass one, the widest blast radius the service has — so
    unlike the reads it gets the full triad rather than silence on success
    ([[logging-context]]). The identities matter more here than anywhere else in
    the service: this is the one route where they arrive in the BODY rather than
    the `x-user-id` header, so nothing upstream in the request pipeline seeds them
    and a line without them cannot be joined to the Users-side cascade log at all.
    """

    def test_a_successful_delete_logs_started_and_succeeded(
        self,
        client: TestClient,
        seeded_tracking: Tracking,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        with caplog.at_level(logging.INFO, logger=ROUTER_LOGGER):
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
        assert len(flow_lines(caplog, "internal_delete_by_user_started")) == 1
        assert len(flow_lines(caplog, "internal_delete_by_user_succeeded")) == 1

    def test_the_started_line_is_emitted_only_after_auth_passes(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """A rejected key must not look like a flow that began.

        `*_started` on an unauthenticated request would make every probe of this
        surface indistinguishable from a real cascade leg in the log stream.
        """
        with caplog.at_level(logging.INFO, logger=ROUTER_LOGGER):
            response = client.request(
                "DELETE",
                PATH,
                json={"cognito_sub": "s", "user_id": "u"},
                headers={"x-api-key": "wrong"},
            )

        assert response.status_code == 401
        assert flow_lines(caplog, "internal_delete_by_user_started") == []

    def test_the_succeeded_line_carries_both_identities_and_the_count(
        self,
        client: TestClient,
        seeded_tracking: Tracking,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The regression this class exists for.

        The line used to carry `app_event` and `deleted_count` alone — no way to
        tell WHOSE trackings were erased. The two identities reach it through the
        ambient log context (both are in `_ALLOWED_KEYS`), while `deleted_count`
        must stay on the call's own `extra=`: `_clean` drops every key outside
        that allow-list SILENTLY, so a count routed through the context would
        vanish with no error at all.

        Asserted through the app's OWN `LogContextFilter`, installed on caplog's
        handler for the duration of the request — not called afterwards on the
        captured record. The context is a `contextvar` and this is a sync handler,
        so it is live only on the threadpool worker, inside the `logger.info` call;
        by the time the test thread inspects the record it is long gone. Enriching
        where the real pipeline enriches (on the handler) is what makes this assert
        about the line that would actually be emitted.
        """
        caplog.handler.addFilter(LogContextFilter())
        try:
            with caplog.at_level(logging.INFO, logger=ROUTER_LOGGER):
                response = client.request(
                    "DELETE",
                    PATH,
                    json={
                        "cognito_sub": seeded_tracking.cognito_sub,
                        "user_id": seeded_tracking.user_id,
                    },
                    headers={"x-api-key": KEY},
                )
        finally:
            caplog.handler.filters = [
                f
                for f in caplog.handler.filters
                if not isinstance(f, LogContextFilter)
            ]

        assert response.status_code == 200
        line = flow_lines(caplog, "internal_delete_by_user_succeeded")[0]

        assert getattr(line, "cognito_sub", None) == seeded_tracking.cognito_sub
        assert getattr(line, "user_id", None) == seeded_tracking.user_id
        # Two DISTINCT values (a Cognito sub and a `usr_` id), per CLAUDE.md §5b —
        # one value for both could not fail on a handler that swapped them.
        assert line.cognito_sub != line.user_id
        # Still on the `extra=`, where `_clean` cannot reach it.
        assert getattr(line, "deleted_count", None) == 1

    def test_a_db_fault_logs_failed_with_a_reason(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """The branch that used to 500 in silence.

        Users has already deleted the account by the time it calls us, so a fault
        here leaves the cascade half-applied — the outcome that most needs to be
        findable was the only one with no `*_failed` line and no reason.
        """
        from src.features.tracking.api import internal_router

        def explode(*args: object, **kwargs: object) -> int:
            raise RuntimeError("connection reset by peer")

        monkeypatch.setattr(internal_router, "delete_by_user", explode)

        with (
            caplog.at_level(logging.INFO, logger=ROUTER_LOGGER),
            pytest.raises(RuntimeError),
        ):
            client.request(
                "DELETE",
                PATH,
                json={"cognito_sub": "s", "user_id": "u"},
                headers={"x-api-key": KEY},
            )

        lines = flow_lines(caplog, "internal_delete_by_user_failed")
        assert len(lines) == 1
        assert lines[0].levelno == logging.WARNING
        assert getattr(lines[0], "reason", None) == "db_error"
        # It got as far as starting, which is what tells a reader the key was good
        # and the fault is ours.
        assert len(flow_lines(caplog, "internal_delete_by_user_started")) == 1
        assert flow_lines(caplog, "internal_delete_by_user_succeeded") == []

    def test_the_401_line_names_the_client_and_never_the_key(
        self, client: TestClient, caplog: pytest.LogCaptureFixture
    ) -> None:
        """Pinned, not changed: `client` is the only lead a rejected probe leaves.

        The key must never appear in any form — not a prefix, not its length.
        A mass soft-delete surface is the widest blast radius this service has.

        Asserted as an ALLOW-LIST of field names rather than by hunting for the
        secret's shape in the record. Both looser forms were tried and both
        produced failures that had nothing to do with the key: `str(len(secret))
        not in rendered` matches the digits of the thread id and the random
        `request_id`, and a numeric `value != len(secret)` matches a `duration_ms`
        that happened to be `20.0`. An allow-list also fails CLOSED — a future
        field carrying the key would have to be added here deliberately, whereas a
        substring search only catches the shapes someone thought to look for.
        """
        secret = "wrong-but-secret-key"
        with caplog.at_level(logging.INFO, logger=AUTH_LOGGER):
            response = client.request(
                "DELETE",
                PATH,
                json={"cognito_sub": "s", "user_id": "u"},
                headers={"x-api-key": secret},
            )

        assert response.status_code == 401
        line = flow_lines(caplog, "internal_delete_by_user_failed")[0]
        assert getattr(line, "reason", None) == "invalid_api_key"
        assert getattr(line, "client", None)

        assert secret not in str(line.__dict__)
        # The fields this line is allowed to carry, beyond logging's own record
        # attributes. Anything else added here has to be a deliberate edit.
        extras = {
            key
            for key in vars(line)
            if key not in vars(logging.makeLogRecord({}))
            and key not in {"message", "asctime", "taskName"}
        }
        # `request_id` is seeded unconditionally by the middleware and must be on
        # every line, including a 401 — that is the whole point of seeding it at
        # ingress rather than after the auth guard ([[logging-context]]).
        assert extras == {"app_event", "reason", "client", "request_id"}
        # And no string field is a prefix of the key either.
        for value in vars(line).values():
            if isinstance(value, str) and len(value) >= 4:
                assert not secret.startswith(value[:4])


class TestWorkflowSpan:
    """The span carries the SAME `app_event`/`reason` tokens as the log line.

    Not "a span exists": a span whose attributes drift from the log leaves trace
    and logs telling two different stories, which is precisely what the convention
    forbids ([[logging-context]]).
    """

    def test_a_successful_delete_produces_an_internal_span(
        self,
        client: TestClient,
        seeded_tracking: Tracking,
        exporter: InMemorySpanExporter,
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
        spans = [
            span
            for span in exporter.get_finished_spans()
            if span.name == "internal_delete_by_user"
        ]
        assert len(spans) == 1
        span = spans[0]
        assert span.kind is SpanKind.INTERNAL
        assert span.attributes["app_event"] == "internal_delete_by_user_succeeded"
        assert span.attributes["cognito_sub"] == seeded_tracking.cognito_sub
        assert span.attributes["user_id"] == seeded_tracking.user_id
        assert span.attributes["deleted_count"] == 1
        assert span.status.status_code.name == "OK"

    def test_a_db_fault_sets_error_status_and_the_same_reason(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        exporter: InMemorySpanExporter,
    ) -> None:
        """`get_finished_spans` only contains spans that ENDED.

        So this also pins that the span closes on the exception path — an unclosed
        span is not an error anywhere, it just never reaches the backend while the
        code still looks instrumented.
        """
        from src.features.tracking.api import internal_router

        def explode(*args: object, **kwargs: object) -> int:
            raise RuntimeError("connection reset by peer")

        monkeypatch.setattr(internal_router, "delete_by_user", explode)

        with pytest.raises(RuntimeError):
            client.request(
                "DELETE",
                PATH,
                json={"cognito_sub": "s", "user_id": "u"},
                headers={"x-api-key": KEY},
            )

        spans = [
            span
            for span in exporter.get_finished_spans()
            if span.name == "internal_delete_by_user"
        ]
        assert len(spans) == 1
        assert spans[0].status.status_code.name == "ERROR"
        # The SAME token the `*_failed` line carries, not a paraphrase of it.
        assert spans[0].attributes["reason"] == "db_error"

    def test_a_rejected_key_opens_no_span(
        self, client: TestClient, exporter: InMemorySpanExporter
    ) -> None:
        """The dependency rejects before the handler runs, so there is no flow."""
        response = client.request(
            "DELETE",
            PATH,
            json={"cognito_sub": "s", "user_id": "u"},
            headers={"x-api-key": "wrong"},
        )

        assert response.status_code == 401
        assert [
            span
            for span in exporter.get_finished_spans()
            if span.name == "internal_delete_by_user"
        ] == []
