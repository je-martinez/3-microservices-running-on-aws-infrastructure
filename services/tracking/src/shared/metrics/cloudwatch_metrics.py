"""CloudWatch custom-metrics publisher.

The wiring mirrors `shared/messaging/sqs_event_publisher.py` exactly: a Protocol
port, a concrete boto3-backed implementation, a no-op binding for suites that
must not reach AWS, and an `lru_cache`d factory keyed on PRIMITIVES (never on
`Settings`, which is unhashable — see `_cached_publisher` below). `shared/di/` in
this service is an empty placeholder; there is no framework container to register
into.

## One responsibility

This module turns a `(name, value, dimensions)` triple into one `PutMetricData`
call and nothing else. The SCHEDULING and the QUERIES live in
`features/tracking/commands/publish_metrics.py`. That split is what makes this
class unit-testable with a recording double and the loop testable with an
injected fake sleep.

## Failure policy: LOG AND SWALLOW, deliberately

`publish` never raises. A metrics backend being unreachable may never break the
request or the loop that produced the metric — the same stance
`SqsEventPublisher` takes for events, and for the same reason: the metric is a
secondary observation of work that already happened. This is NOT silent: every
failure is an `error` line carrying `app_event=metric_publish_failed`, which is
what makes it alertable.

## The namespace and the dimensions are a contract

Every 3MRAI metric, in every service, is published under the single namespace
`3MRAI`. The dimension SET is equally load-bearing: Floci does not aggregate
across dimensions, so the collector's `GetMetricData` query must name the exact
same set the datum was published with — a query that omits one returns
`Values: []` with `StatusCode: "Complete"`, a silent empty result rather than an
error. Dimensions are therefore low-cardinality labels only; never a user id, an
email or an order id.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any, Protocol

import boto3

from src.shared.config.settings import get_settings

logger = logging.getLogger(__name__)

#: The one namespace every 3MRAI metric is published under, across all four
#: services. Never a per-service namespace.
METRICS_NAMESPACE = "3MRAI"

#: The `Service` dimension value every metric from THIS service carries.
SERVICE_DIMENSION = "tracking"


class MetricsPublisher(Protocol):
    """Port for publishing one metric datum.

    `publish` NEVER raises — that is part of the contract, not an implementation
    detail, and every caller relies on it.
    """

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None: ...


class CloudWatchMetricsPublisher:
    """Publishes to CloudWatch (Floci locally) via boto3.

    **Blocking.** boto3 is synchronous, so an async caller must invoke `publish`
    through `asyncio.to_thread` rather than inline — doing it on the event loop
    would stall the health check and every REST handler for the duration of the
    HTTP round trip.
    """

    def __init__(self, *, client: Any) -> None:
        self._client = client

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        """Emit one datum. Never raises — see the module docstring's policy.

        `value` is published as given, `0` included: a series that stops being
        published reads as "no data" in a dashboard, not as zero, so there is no
        falsy short-circuit here.
        """
        try:
            self._client.put_metric_data(
                Namespace=METRICS_NAMESPACE,
                MetricData=[
                    {
                        "MetricName": name,
                        "Value": value,
                        "Unit": "Count",
                        # CloudWatch's list-of-{Name,Value}, in the mapping's
                        # own (insertion) order. The collector's query must name
                        # this exact set — see the module docstring.
                        "Dimensions": [
                            {"Name": key, "Value": val}
                            for key, val in dimensions.items()
                        ],
                    }
                ],
            )
        except Exception:  # noqa: BLE001 - swallowed on purpose, see the docstring
            logger.exception(
                "metric_publish_failed",
                extra={
                    "app_event": "metric_publish_failed",
                    "reason": "put_metric_data_failed",
                    "metric_name": name,
                },
            )


class NoopMetricsPublisher:
    """Binding for suites (and runtimes) that must not reach CloudWatch."""

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        return None


@lru_cache(maxsize=1)
def _cached_publisher(
    endpoint_url: str | None, region: str
) -> CloudWatchMetricsPublisher:
    """One publisher (hence one boto3 client) per process, keyed on PRIMITIVES.

    Keyed on the values rather than on `Settings` for the reason recorded in
    `shared/db/engine.py`, `shared/grpc/users_client.py` and
    `shared/messaging/sqs_event_publisher.py`: pydantic's `BaseSettings` is
    unhashable, so an `lru_cache` taking a settings object raises `TypeError` on
    its very first call — and that failure is invisible to a test suite that
    injects its own double everywhere.
    """
    client = boto3.client("cloudwatch", endpoint_url=endpoint_url, region_name=region)
    return CloudWatchMetricsPublisher(client=client)


def shared_metrics_publisher() -> CloudWatchMetricsPublisher:
    """The process-wide publisher, built lazily from settings.

    Lazy, not module-level, so importing this module neither constructs a boto3
    client nor requires a valid environment — the same rule
    `shared_event_publisher()` and `shared_users_client()` follow, and what lets
    the test suite import the metrics loop without an env file.
    """
    settings = get_settings()
    return _cached_publisher(settings.aws_endpoint_url, settings.aws_region)
