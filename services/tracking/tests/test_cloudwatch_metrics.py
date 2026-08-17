"""Unit tests for the CloudWatch metrics publisher.

A hand-written recorder rather than `unittest.mock`, matching
`test_sqs_event_publisher.py`: every assertion here is about the exact SHAPE of
the `put_metric_data` call the publisher built, which a recorder makes readable
and a `Mock` hides behind call-args tuples.

The failure test is the one worth reading twice. `FailingCloudWatchClient`
raises, and the temptation is to assert "it raised" — which tests the fake. What
is asserted instead is the publisher's own observable behaviour under that
failure: the call did not propagate to the caller. A metrics backend being down
may never break the request or the loop that produced the metric.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest

from src.shared.metrics.cloudwatch_metrics import (
    METRICS_NAMESPACE,
    CloudWatchMetricsPublisher,
    NoopMetricsPublisher,
)


class RecordingCloudWatchClient:
    """Stands in for boto3's `cloudwatch` client, keeping every call verbatim."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def put_metric_data(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {}


class FailingCloudWatchClient:
    """A client that is down, the way a real outage looks from here."""

    def put_metric_data(self, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("CloudWatch is down")


def test_publishes_one_datum_in_the_3mrai_namespace() -> None:
    client = RecordingCloudWatchClient()
    publisher = CloudWatchMetricsPublisher(client=client)

    publisher.publish(
        "orders_by_tracking_status_total",
        5,
        {"Service": "tracking", "Status": "DELIVERED"},
    )

    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["Namespace"] == METRICS_NAMESPACE == "3MRAI"
    assert len(call["MetricData"]) == 1
    datum = call["MetricData"][0]
    assert datum["MetricName"] == "orders_by_tracking_status_total"
    assert datum["Value"] == 5
    assert datum["Unit"] == "Count"
    # The exact dimension set matters: Floci does NOT aggregate across
    # dimensions, so a query whose dimensions differ from what was published
    # returns an EMPTY result with StatusCode "Complete" — a silent nothing, not
    # an error.
    assert datum["Dimensions"] == [
        {"Name": "Service", "Value": "tracking"},
        {"Name": "Status", "Value": "DELIVERED"},
    ]


def test_publishes_a_zero_value_rather_than_skipping_it() -> None:
    """0 is a real reading, not "nothing to say".

    A series that stops being published reads as "no data" in a dashboard, not
    as zero, so the publisher may never treat a falsy value as a no-op.
    """
    client = RecordingCloudWatchClient()
    publisher = CloudWatchMetricsPublisher(client=client)

    publisher.publish(
        "orders_by_tracking_status_total",
        0,
        {"Service": "tracking", "Status": "IN_PROGRESS"},
    )

    assert len(client.calls) == 1
    assert client.calls[0]["MetricData"][0]["Value"] == 0


def test_never_raises_when_the_client_fails(
    caplog: pytest.LogCaptureFixture,
) -> None:
    publisher = CloudWatchMetricsPublisher(client=FailingCloudWatchClient())

    with caplog.at_level(logging.ERROR):
        # Must not raise: a metric failure may never break the caller.
        publisher.publish(
            "orders_by_tracking_status_total", 1, {"Service": "tracking"}
        )

    # Swallowed, but NOT silent — the failure is alertable.
    assert any(
        getattr(record, "app_event", None) == "metric_publish_failed"
        for record in caplog.records
    )


def test_the_noop_publisher_satisfies_the_port_and_does_nothing() -> None:
    """The binding for suites that must not reach CloudWatch."""
    NoopMetricsPublisher().publish("anything", 1, {"Service": "tracking"})
