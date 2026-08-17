"""Periodic publication of tracking-derived gauges.

Publishes `orders_by_tracking_status_total`, split into DELIVERED (finished
orders) and IN_PROGRESS (everything else). DELIVERED is the state machine's
`TERMINAL_STATUS`, so "finished" is the domain's own invariant rather than a
convention invented here.

Counting trackings IS counting orders: `tracking.order_id` carries a UNIQUE
constraint, so there is exactly one tracking per order and no double counting.

## Gauges, not counters

These report CURRENT state — "how many orders are still in flight" is a question
about the table, not about a stream of events. A counter would have to decrement
when a tracking is delivered, which counters cannot do, and would drift from the
database with no way to explain the difference. The collector queries them with
`stats: [Maximum]` for the same reason: `Sum` would ADD every sample in a window
and report double the real count whenever two publishes land in one window.

## Both series, always, 0 included

Each tick publishes BOTH series even when a count is zero. A series that stops
being published reads as "no data" in a dashboard, not as zero — so an empty
DELIVERED bucket must publish a 0 rather than skip the datum. This is why the
split goes through `collect_status_counts` (which always returns a pair) rather
than iterating whatever statuses the GROUP BY happened to return.

## Structure

Mirrors `test_mode_progression.py`: the interval and `sleep` are injected so the
suite runs in milliseconds, and the blocking DB work (sync pymysql) is pushed to
a worker thread with `asyncio.to_thread` — running it inline would stall the
event loop, and therefore the health check and every REST handler.

UNLIKE that module, a per-tick error is swallowed and the loop CONTINUES. This
loop has no natural end: a transient database blip or a CloudWatch outage must
cost one datapoint, not the rest of the process's metrics.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable

from sqlalchemy import func, select

from src.features.tracking.domain.models import Tracking
from src.features.tracking.domain.status import TrackingStatus
from src.shared.db.engine import read_session
from src.shared.metrics.cloudwatch_metrics import (
    SERVICE_DIMENSION,
    MetricsPublisher,
    shared_metrics_publisher,
)

logger = logging.getLogger(__name__)

#: Seconds between two ticks. Overridden from `Settings.metrics_interval_seconds`
#: at startup; 15s locally, 60s in real AWS.
DEFAULT_INTERVAL_SECONDS = 15.0

#: The metric name, and the dimension keys it is broken down by. Named constants
#: because the collector's `queries` block in
#: `observability/otel-collector-config.yaml` must match them EXACTLY — Floci
#: does not aggregate across dimensions, so a mismatch is a silent empty result
#: rather than an error.
METRIC_NAME = "orders_by_tracking_status_total"
STATUS_DELIVERED = "DELIVERED"
STATUS_IN_PROGRESS = "IN_PROGRESS"
#: Sentinel for the pre-summed total — see the publish call for why it is a
#: published series rather than something a dashboard adds up.
STATUS_ALL = "ALL"

#: The error counter this loop seeds at zero, and the classes it is split by.
#: Must match what `log_context_middleware` publishes on the error path, or the
#: seed and the real increments would land on different series.
HTTP_ERRORS_METRIC = "http_errors_total"
HTTP_ERROR_CLASSES = ("4xx", "5xx")


def collect_status_counts(raw: dict[str, int]) -> tuple[int, int]:
    """Split raw per-status counts into `(delivered, in_progress)`.

    Pure, so the split is unit-testable without a database. Both values are
    always returned, 0 included: a series that stops being published reads as
    "no data" in a dashboard rather than as zero.

    Anything that is not the terminal status counts as in progress — including a
    status this code does not know about. That direction is deliberate: a new
    status added to the progression should land in "still in flight" by default
    rather than silently disappear from both series.
    """
    delivered = raw.get(TrackingStatus.DELIVERED.value, 0)
    in_progress = sum(
        count
        for status, count in raw.items()
        if status != TrackingStatus.DELIVERED.value
    )
    return delivered, in_progress


def _query_status_counts() -> dict[str, int]:
    """One GROUP BY over LIVE trackings. Blocking — call via `asyncio.to_thread`.

    Soft-deleted rows are excluded ([[soft-delete]]): a deleted tracking is not
    an order in flight, and counting it would make the gauge disagree with every
    user-facing read, all of which filter the same way.
    """
    with read_session() as session:
        stmt = (
            select(Tracking.status, func.count())
            .where(Tracking.deleted_at.is_(None))
            .group_by(Tracking.status)
        )
        return {status: count for status, count in session.execute(stmt).all()}


async def run_metrics_publisher(
    *,
    interval: float = DEFAULT_INTERVAL_SECONDS,
    publisher: MetricsPublisher | None = None,
    query: Callable[[], dict[str, int]] = _query_status_counts,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Publish the gauges forever, one tick per `interval`.

    Sleeps FIRST, then publishes: at startup the database may not be reachable
    yet, and a tick before the first interval would only produce a failure line
    nobody can act on.

    `publisher` defaults to the process-wide `shared_metrics_publisher()`, and is
    resolved lazily inside this coroutine rather than as a default argument — a
    default is evaluated at import time, which would construct a boto3 client
    (and require a valid environment) merely by importing this module.

    Only `asyncio.CancelledError` ends this coroutine. Everything else is logged
    with a machine-readable `reason` and the loop continues; see the module
    docstring.
    """
    resolved = publisher if publisher is not None else shared_metrics_publisher()

    logger.info(
        "metrics_publisher_started",
        extra={
            "app_event": "metrics_publisher_started",
            "interval_seconds": interval,
        },
    )

    try:
        while True:
            await sleep(interval)
            try:
                # Both the query and the publish are BLOCKING (pymysql, boto3),
                # so both are pushed off the event loop.
                raw = await asyncio.to_thread(query)
                delivered, in_progress = collect_status_counts(raw)

                await asyncio.to_thread(
                    resolved.publish,
                    METRIC_NAME,
                    delivered,
                    {"Service": SERVICE_DIMENSION, "Status": STATUS_DELIVERED},
                )
                await asyncio.to_thread(
                    resolved.publish,
                    METRIC_NAME,
                    in_progress,
                    {"Service": SERVICE_DIMENSION, "Status": STATUS_IN_PROGRESS},
                )
                # The TOTAL as its own published series, for two independent
                # reasons — either alone would justify it:
                #
                # 1. CloudWatch under Floci does not aggregate across
                #    dimensions, so a query omitting Status comes back empty.
                # 2. Summing the two series in PromQL does not work either: the
                #    collector stamps each scrape with a distinct start_time, so
                #    the breakdowns rarely share a timestamp and `sum()`
                #    silently returns only one of them.
                #
                # One number, one timestamp, computed where the data lives.
                await asyncio.to_thread(
                    resolved.publish,
                    METRIC_NAME,
                    delivered + in_progress,
                    {"Service": SERVICE_DIMENSION, "Status": STATUS_ALL},
                )

                # Seed the failure counters at zero.
                #
                # `http_errors_total` is emitted from the error path only, so
                # until something fails the series does not exist and a panel
                # over it renders "Error Loading Data" — the incident card that
                # should read "no errors" is the one that looks broken, which
                # makes a real outage indistinguishable from a healthy system.
                #
                # A zero is arithmetically free: CloudWatch sums within a
                # period, so it never changes a real count. Same rule already
                # applied to the status breakdown above.
                for status_class in HTTP_ERROR_CLASSES:
                    await asyncio.to_thread(
                        resolved.publish,
                        HTTP_ERRORS_METRIC,
                        0,
                        {
                            "Service": SERVICE_DIMENSION,
                            "StatusClass": status_class,
                        },
                    )
            except asyncio.CancelledError:
                # Cancellation must never be caught by the per-tick handler
                # below: swallowing it would make this loop unkillable and hang
                # shutdown. Re-raised into the outer handler, which logs and
                # re-raises again.
                raise
            except Exception:  # noqa: BLE001 - one bad tick must not kill the loop
                logger.exception(
                    "metrics_collection_failed",
                    extra={
                        "app_event": "metrics_collection_failed",
                        "reason": "unexpected_error",
                    },
                )
    except asyncio.CancelledError:
        # Shutdown. Re-raised so cancellation keeps working.
        logger.info(
            "metrics_publisher_cancelled",
            extra={"app_event": "metrics_publisher_cancelled"},
        )
        raise
