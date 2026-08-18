"""`workflow_span` — the manual span every Tracking flow is wrapped in.

What these tests actually defend:

## The span must close on BOTH paths

A span that is never ended is not an error anywhere — it simply never reaches
Jaeger, so the flow vanishes from the cascade while the code looks instrumented.
The failure case below therefore asserts the span was *exported* at all, not
merely that its status is ERROR: `get_finished_spans()` only ever contains spans
that ended.

## The status/reason pair must match the flow log

The convention is that a trace and its logs tell the SAME story
([[logging-context]]): a `*_failed` log line carries a machine-readable `reason`,
and so must the span. Asserting the attribute here is what stops the two drifting
into "the log says invalid_status, the span says nothing".

## Why a private provider, and why in a fixture

`trace.set_tracer_provider` is a one-shot global — a second call is ignored with
a warning, so a module-level `set_tracer_provider` here would either lose to
whatever another test module installed first or silently win over it. Instead the
tracer used by `workflow_tracing` is swapped for a local one for the duration of
each test, which leaves the global untouched and keeps this file runnable in any
order alongside the rest of the suite.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
    InMemorySpanExporter,
)
from opentelemetry.trace import SpanKind

from src.shared.observability import workflow_tracing
from src.shared.observability.workflow_tracing import workflow_span


@pytest.fixture
def exporter(monkeypatch: pytest.MonkeyPatch) -> Iterator[InMemorySpanExporter]:
    """A private tracer provider, wired into the module under test only."""
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    monkeypatch.setattr(
        workflow_tracing, "_tracer", provider.get_tracer("tracking-workflow")
    )
    yield memory
    memory.clear()


def test_creates_internal_span_with_attributes_and_ok_status(
    exporter: InMemorySpanExporter,
) -> None:
    with workflow_span(
        "init_tracking", app_event="init_tracking_started", order_id="ord_1"
    ):
        pass

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].name == "init_tracking"
    assert spans[0].kind is SpanKind.INTERNAL
    assert spans[0].attributes["app_event"] == "init_tracking_started"
    assert spans[0].attributes["order_id"] == "ord_1"
    assert spans[0].status.status_code.name == "OK"


def test_sets_error_status_and_records_exception_on_failure(
    exporter: InMemorySpanExporter,
) -> None:
    with (
        pytest.raises(ValueError),
        workflow_span(
            "carrier_status_update", app_event="carrier_status_update_started"
        ) as span,
    ):
        # The same token the flow's `*_failed` log line carries — set from
        # inside the block, exactly as the routers do in their except arms.
        span.set_attribute("reason", "invalid_status")
        raise ValueError("bad status")

    spans = exporter.get_finished_spans()
    # Exported at all == it was ended on the exception path.
    assert len(spans) == 1
    assert spans[0].status.status_code.name == "ERROR"
    assert spans[0].status.description == "bad status"
    assert spans[0].attributes["reason"] == "invalid_status"
    # EXACTLY one: the SDK records the exception itself unless told not to, and
    # the default would have this span carrying the same event twice.
    assert [event.name for event in spans[0].events] == ["exception"]


def test_reraises_the_original_exception(exporter: InMemorySpanExporter) -> None:
    """The wrapper must be transparent: the caller still sees its own error.

    The routers turn these into HTTP status codes, so swallowing or wrapping one
    here would change a 409 into a 500 without touching the handler.
    """
    original = KeyError("untouched")

    with pytest.raises(KeyError) as caught, workflow_span("init_tracking"):
        raise original

    assert caught.value is original


def test_span_is_active_inside_the_block(exporter: InMemorySpanExporter) -> None:
    """Nested work joins the workflow span, and `TraceContextFilter` sees it.

    This is what puts `trace_id` on every log line of the flow: the filter reads
    `trace.get_current_span()`, so the span has to be the CURRENT one, not merely
    created.
    """
    from opentelemetry import trace

    with workflow_span("test_mode_progression", order_id="ord_2") as span:
        current = trace.get_current_span()
        assert current is span
        assert current.get_span_context().is_valid
