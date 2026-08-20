"""Unit tests for the periodic metrics loop.

No database and no CloudWatch: the status query and the publisher are both
injected, and `sleep` is a fake, so the loop runs deterministically and
instantly.

The split between `collect_status_counts` (pure) and `run_metrics_publisher`
(scheduling) is what makes that possible: the interesting arithmetic — what
counts as IN_PROGRESS, and that a missing status is published as 0 rather than
omitted — is testable with a plain dict.
"""

from __future__ import annotations

import asyncio

import pytest

from src.features.tracking.commands.publish_metrics import (
    collect_status_counts,
    run_metrics_publisher,
)


class RecordingPublisher:
    """Records every published datum, in order."""

    def __init__(self) -> None:
        self.published: list[tuple[str, float, dict[str, str]]] = []

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        self.published.append((name, value, dimensions))


class FailingPublisher:
    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        raise RuntimeError("CloudWatch is down")


def test_collect_status_counts_splits_delivered_from_in_progress() -> None:
    # Raw per-status counts as the SQL GROUP BY would return them.
    raw = {"PLACED": 2, "SHIPPED": 3, "DELIVERED": 4}

    delivered, in_progress = collect_status_counts(raw)

    assert delivered == 4
    # Everything that is not DELIVERED is unfinished: 2 + 3.
    assert in_progress == 5


def test_collect_status_counts_reports_zero_rather_than_omitting_a_series() -> None:
    # No delivered trackings at all. The series must still be reported as 0 —
    # a series that stops updating reads as "no data" in a dashboard, not as
    # zero.
    delivered, in_progress = collect_status_counts({"PLACED": 1})

    assert delivered == 0
    assert in_progress == 1


def test_collect_status_counts_handles_an_empty_table() -> None:
    assert collect_status_counts({}) == (0, 0)


async def _run_ticks(
    publisher: object,
    query,
    *,
    ticks: int,
) -> None:
    """Drive the loop for exactly `ticks` iterations, then cancel it.

    The loop never ends on its own — that is its contract — so the only way to
    observe N ticks is to cancel it after the (N+1)th sleep. The fake `sleep`
    counts the calls and raises `CancelledError` once the quota is spent, which
    is exactly how cancellation reaches the coroutine at shutdown.
    """
    calls = 0

    async def fake_sleep(_seconds: float) -> None:
        nonlocal calls
        calls += 1
        if calls > ticks:
            raise asyncio.CancelledError
        # Yield to the loop so `asyncio.to_thread` inside the tick can run.
        await asyncio.sleep(0)

    with pytest.raises(asyncio.CancelledError):
        await run_metrics_publisher(
            interval=0,
            publisher=publisher,  # type: ignore[arg-type]
            query=query,
            sleep=fake_sleep,
        )


async def test_one_tick_publishes_both_series_with_their_dimensions() -> None:
    publisher = RecordingPublisher()

    await _run_ticks(
        publisher,
        lambda: {"PLACED": 2, "SHIPPED": 3, "DELIVERED": 4},
        ticks=1,
    )

    gauge = [
        row
        for row in publisher.published
        if row[0] == "orders_by_tracking_status_total"
    ]
    assert gauge == [
        (
            "orders_by_tracking_status_total",
            4,
            {"Service": "tracking", "Status": "DELIVERED"},
        ),
        (
            "orders_by_tracking_status_total",
            5,
            {"Service": "tracking", "Status": "IN_PROGRESS"},
        ),
        # The pre-summed total. Published rather than derived because neither
        # CloudWatch nor PromQL can compute it downstream — see the publisher.
        (
            "orders_by_tracking_status_total",
            9,
            {"Service": "tracking", "Status": "ALL"},
        ),
    ]


async def test_both_series_are_published_even_when_a_count_is_zero() -> None:
    """An empty table still publishes every series, all 0.

    This is the single most important behaviour in this module: skipping a
    zero-valued series makes a dashboard show a GAP, which reads as a broken
    pipeline rather than as "nothing in that state".
    """
    publisher = RecordingPublisher()

    await _run_ticks(publisher, dict, ticks=1)

    assert [
        (value, dims["Status"])
        for name, value, dims in publisher.published
        if name == "orders_by_tracking_status_total"
    ] == [
        (0, "DELIVERED"),
        (0, "IN_PROGRESS"),
        (0, "ALL"),
    ]


async def test_the_all_series_equals_the_sum_of_the_breakdowns() -> None:
    """ALL must be DELIVERED + IN_PROGRESS, not an independently derived number.

    Worth pinning: the whole reason this series exists is that a dashboard
    cannot add the two together correctly, so a drift here would be invisible
    downstream — the card would simply show a confident wrong total.
    """
    publisher = RecordingPublisher()

    await _run_ticks(
        publisher,
        lambda: {"PLACED": 2, "SHIPPED": 3, "DELIVERED": 4},
        ticks=1,
    )

    by_status = {
        dims["Status"]: value
        for name, value, dims in publisher.published
        if name == "orders_by_tracking_status_total"
    }
    assert by_status["ALL"] == by_status["DELIVERED"] + by_status["IN_PROGRESS"]
    assert by_status["ALL"] == 9


async def test_error_counters_are_seeded_at_zero_every_tick() -> None:
    """Every tick publishes http_errors_total at 0 for both status classes.

    Without this the series only exists once something has failed, and a
    dashboard panel over a stream that does not exist renders "Error Loading
    Data" — so the card that should read "no errors" is the one that looks
    broken, and a real outage is indistinguishable from a healthy system.

    The zero costs nothing: CloudWatch sums within a period, so seeding never
    changes a real count.
    """
    publisher = RecordingPublisher()

    await _run_ticks(publisher, dict, ticks=1)

    seeded = {
        dims["StatusClass"]: value
        for name, value, dims in publisher.published
        if name == "http_errors_total"
    }
    assert seeded == {"4xx": 0, "5xx": 0}


async def test_a_failing_query_does_not_end_the_loop() -> None:
    """One bad tick must not kill the loop — it never ends on its own."""
    publisher = RecordingPublisher()
    attempts = 0

    def flaky() -> dict[str, int]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("database is down")
        return {"DELIVERED": 1}

    await _run_ticks(publisher, flaky, ticks=2)

    # The first tick raised and was swallowed; the second still published.
    assert attempts == 2
    # One tick's worth of series, not a hardcoded count: asserting a literal
    # number here breaks every time a series is added, which says nothing about
    # the behaviour under test (that the loop SURVIVED the failing tick).
    statuses = {
        dims["Status"]
        for name, _, dims in publisher.published
        if name == "orders_by_tracking_status_total"
    }
    assert statuses == {"DELIVERED", "IN_PROGRESS", "ALL"}
    assert publisher.published[0][1] == 1


async def test_a_failing_publisher_does_not_end_the_loop() -> None:
    """Even a publisher that (against its own contract) raises is contained."""
    await _run_ticks(FailingPublisher(), lambda: {"DELIVERED": 1}, ticks=2)


class TracedPublisher(RecordingPublisher):
    """Records the span that was CURRENT at each publish, alongside the datum.

    Capturing the context from inside the callback is the whole point: an
    assertion that the `metrics-tick` span merely exists would still pass if the
    query and the publishes ran outside it and re-rooted themselves, which is
    precisely the bug (60 orphan `connect` / `SELECT tracking` traces in an hour).
    """

    def __init__(self) -> None:
        super().__init__()
        self.contexts: list[object] = []

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        from opentelemetry import trace

        self.contexts.append(trace.get_current_span().get_span_context())
        super().publish(name, value, dimensions)


@pytest.fixture
def tick_exporter(monkeypatch: pytest.MonkeyPatch):
    """A private tracer provider wired into `workflow_tracing` for one test.

    `trace.set_tracer_provider` is a one-shot global, so swapping the module's
    own tracer instead keeps this file runnable in any order alongside the rest
    of the suite — the same approach `test_workflow_tracing.py` takes.
    """
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
        InMemorySpanExporter,
    )

    from src.shared.observability import workflow_tracing

    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(memory))
    monkeypatch.setattr(
        workflow_tracing, "_tracer", provider.get_tracer("tracking-workflow")
    )
    yield memory
    memory.clear()


async def test_each_tick_runs_inside_a_metrics_tick_span(tick_exporter) -> None:
    """The tick's work is a CHILD of `metrics-tick`, not a sibling of it.

    The loop runs on a timer with no ambient request span, so without this
    wrapper every tick's SQLAlchemy and boto3 spans arrive at Jaeger as their own
    anonymous root traces and bury the real request traces.
    """
    from opentelemetry.trace import SpanKind

    publisher = TracedPublisher()
    seen_in_query: list[object] = []

    def query() -> dict[str, int]:
        from opentelemetry import trace

        seen_in_query.append(trace.get_current_span().get_span_context())
        return {"PLACED": 1, "DELIVERED": 2}

    await _run_ticks(publisher, query, ticks=1)

    spans = tick_exporter.get_finished_spans()
    assert [span.name for span in spans] == ["metrics-tick"]
    tick = spans[0]
    # INTERNAL, not CONSUMER: this is our own timer, it consumes nothing.
    assert tick.kind is SpanKind.INTERNAL
    assert tick.attributes["app_event"] == "metrics_tick_succeeded"
    assert tick.status.status_code.name == "OK"

    # The database read and EVERY publish saw the tick span as current, so their
    # own auto-instrumented spans parent themselves to it instead of re-rooting.
    # `to_thread` copies the context into the worker thread, which is what makes
    # this hold across the thread boundary.
    assert seen_in_query == [tick.context]
    assert publisher.contexts, "the tick published nothing"
    # Compared by id rather than by identity: a SpanContext is not hashable,
    # and the (trace_id, span_id) pair is exactly what "same parent" means on
    # the wire anyway.
    assert {(ctx.trace_id, ctx.span_id) for ctx in publisher.contexts} == {
        (tick.context.trace_id, tick.context.span_id)
    }


async def test_a_failing_tick_ends_its_span_as_error(tick_exporter) -> None:
    """A swallowed tick failure still leaves an ERROR span behind.

    The `except` that keeps the loop alive lives OUTSIDE the span, so the span
    sees the throw. Catching inside would close every failed tick as OK and make
    a broken publisher indistinguishable from a healthy one in Jaeger.
    """
    publisher = RecordingPublisher()
    attempts = 0

    def flaky() -> dict[str, int]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("database is down")
        return {"DELIVERED": 1}

    await _run_ticks(publisher, flaky, ticks=2)

    spans = tick_exporter.get_finished_spans()
    assert [span.name for span in spans] == ["metrics-tick", "metrics-tick"]
    failed, recovered = spans
    assert failed.status.status_code.name == "ERROR"
    assert failed.status.description == "database is down"
    # `*_started` with no `*_succeeded` is what makes a failed tick legible.
    assert failed.attributes["app_event"] == "metrics_tick_started"
    assert recovered.status.status_code.name == "OK"
    assert recovered.attributes["app_event"] == "metrics_tick_succeeded"
