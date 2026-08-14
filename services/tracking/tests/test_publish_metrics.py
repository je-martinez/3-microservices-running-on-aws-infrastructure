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

    assert publisher.published == [
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

    assert [(value, dims["Status"]) for _, value, dims in publisher.published] == [
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

    by_status = {dims["Status"]: value for _, value, dims in publisher.published}
    assert by_status["ALL"] == by_status["DELIVERED"] + by_status["IN_PROGRESS"]
    assert by_status["ALL"] == 9


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
    statuses = {dims["Status"] for _, _, dims in publisher.published}
    assert statuses == {"DELIVERED", "IN_PROGRESS", "ALL"}
    assert publisher.published[0][1] == 1


async def test_a_failing_publisher_does_not_end_the_loop() -> None:
    """Even a publisher that (against its own contract) raises is contained."""
    await _run_ticks(FailingPublisher(), lambda: {"DELIVERED": 1}, ticks=2)
