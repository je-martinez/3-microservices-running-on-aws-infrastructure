"""The cache transport: JSON round trip, TTL, the index, and fail-open.

Uses `fakeredis`, not a real server — see the rationale in requirements.txt.
The failure tests use a client whose every method raises, which is what a
timeout or a dropped connection looks like from this code's side.
"""

from typing import Any

import fakeredis
import pytest

from src.shared.cache.gateway import CacheGateway
from src.shared.metrics.cloudwatch_metrics import NoopMetricsPublisher


class ExplodingRedis:
    """Every operation fails, exactly as an unreachable Redis does."""

    def get(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def setex(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def delete(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def ttl(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def sadd(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def smembers(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")

    def expire(self, *args: Any, **kwargs: Any) -> Any:
        raise ConnectionError("redis is down")


class RecordingPublisher:
    """Captures every metric datum, so a test can assert on dimensions."""

    def __init__(self) -> None:
        self.data: list[tuple[str, float, dict[str, str]]] = []

    def publish(self, name: str, value: float, dimensions: dict[str, str]) -> None:
        self.data.append((name, value, dimensions))


@pytest.fixture
def redis_double() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis(decode_responses=True)


@pytest.fixture
def gateway(redis_double: fakeredis.FakeRedis) -> CacheGateway:
    return CacheGateway(client=redis_double, metrics=NoopMetricsPublisher())


class TestRoundTrip:
    def test_miss_on_an_unknown_key(self, gateway: CacheGateway) -> None:
        entry = gateway.get("tracking:order:v1:s:u:ord_1")
        assert entry.hit is False
        assert entry.bypassed is False
        assert entry.value is None
        assert entry.ttl_remaining is None

    def test_set_then_get_returns_the_value(self, gateway: CacheGateway) -> None:
        gateway.set("tracking:order:v1:s:u:ord_1", {"status": "SHIPPED"}, 60)
        entry = gateway.get("tracking:order:v1:s:u:ord_1")
        assert entry.hit is True
        assert entry.value == {"status": "SHIPPED"}

    def test_hit_reports_the_remaining_ttl(self, gateway: CacheGateway) -> None:
        gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
        entry = gateway.get("tracking:order:v1:s:u:ord_1")
        assert entry.ttl_remaining is not None
        assert 0 < entry.ttl_remaining <= 60

    def test_nested_structures_survive_the_round_trip(
        self, gateway: CacheGateway
    ) -> None:
        """The cached body is a whole TrackingResponse, history included."""
        body = {
            "id": "trk_1",
            "history": [{"status": "PLACED"}, {"status": "SHIPPED"}],
        }
        gateway.set("tracking:order:v1:s:u:ord_1", body, 60)
        assert gateway.get("tracking:order:v1:s:u:ord_1").value == body


class TestInvalidate:
    def test_removes_the_key(self, gateway: CacheGateway) -> None:
        gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
        gateway.invalidate("tracking:order:v1:s:u:ord_1")
        assert gateway.get("tracking:order:v1:s:u:ord_1").hit is False

    def test_deleting_an_absent_key_is_not_an_error(
        self, gateway: CacheGateway
    ) -> None:
        gateway.invalidate("tracking:order:v1:s:u:nope")

    def test_no_keys_is_a_no_op(self, gateway: CacheGateway) -> None:
        gateway.invalidate()


class TestUserIndex:
    def test_set_with_an_index_records_the_key(
        self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
    ) -> None:
        gateway.set(
            "tracking:list:v1:s:u:abcd",
            {"trackings": []},
            60,
            index_key="tracking:index:v1:s:u",
        )
        assert redis_double.smembers("tracking:index:v1:s:u") == {
            "tracking:list:v1:s:u:abcd"
        }

    def test_the_index_outlives_the_entries_it_tracks(
        self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
    ) -> None:
        """An index that expired first would orphan keys nothing could evict."""
        gateway.set(
            "tracking:list:v1:s:u:abcd",
            {"trackings": []},
            60,
            index_key="tracking:index:v1:s:u",
        )
        assert redis_double.ttl("tracking:index:v1:s:u") > 60

    def test_invalidate_index_removes_every_member_and_the_index(
        self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
    ) -> None:
        index = "tracking:index:v1:s:u"
        gateway.set("tracking:list:v1:s:u:aaa", {"n": 1}, 60, index_key=index)
        gateway.set("tracking:list:v1:s:u:bbb", {"n": 2}, 60, index_key=index)

        gateway.invalidate_index(index)

        assert gateway.get("tracking:list:v1:s:u:aaa").hit is False
        assert gateway.get("tracking:list:v1:s:u:bbb").hit is False
        assert redis_double.smembers(index) == set()

    def test_invalidating_an_empty_index_is_not_an_error(
        self, gateway: CacheGateway
    ) -> None:
        gateway.invalidate_index("tracking:index:v1:s:nobody")


class TestFailOpen:
    """Redis being down must produce a BYPASS, never an exception."""

    @pytest.fixture
    def broken(self) -> CacheGateway:
        return CacheGateway(client=ExplodingRedis(), metrics=NoopMetricsPublisher())

    def test_get_bypasses(self, broken: CacheGateway) -> None:
        entry = broken.get("tracking:order:v1:s:u:ord_1")
        assert entry.bypassed is True
        assert entry.hit is False
        assert entry.value is None

    def test_set_swallows(self, broken: CacheGateway) -> None:
        broken.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)

    def test_set_with_an_index_swallows(self, broken: CacheGateway) -> None:
        broken.set(
            "tracking:list:v1:s:u:abcd",
            {"a": 1},
            60,
            index_key="tracking:index:v1:s:u",
        )

    def test_invalidate_swallows(self, broken: CacheGateway) -> None:
        broken.invalidate("tracking:order:v1:s:u:ord_1")

    def test_invalidate_index_swallows(self, broken: CacheGateway) -> None:
        broken.invalidate_index("tracking:index:v1:s:u")

    def test_a_corrupt_payload_is_a_miss_not_a_crash(
        self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
    ) -> None:
        """Someone else's key, a truncated write, a version skew."""
        redis_double.set("tracking:order:v1:s:u:ord_1", "{not json")
        assert gateway.get("tracking:order:v1:s:u:ord_1").hit is False

    def test_a_corrupt_payload_is_NOT_a_bypass(
        self, gateway: CacheGateway, redis_double: fakeredis.FakeRedis
    ) -> None:
        """Redis answered — the ENTRY is broken, not the server."""
        redis_double.set("tracking:order:v1:s:u:ord_1", "{not json")
        assert gateway.get("tracking:order:v1:s:u:ord_1").bypassed is False


class TestMetrics:
    def test_a_hit_publishes_the_PREFIX_never_the_full_key(self) -> None:
        publisher = RecordingPublisher()
        gateway = CacheGateway(
            client=fakeredis.FakeRedis(decode_responses=True), metrics=publisher
        )
        key = "tracking:order:v1:secret-sub:usr_secret:ord_1"
        gateway.set(key, {"a": 1}, 60)
        gateway.get(key)

        requests = [d for d in publisher.data if d[0] == "cache_requests_total"]
        assert requests, "cache_requests_total was never published"
        _name, value, dimensions = requests[-1]
        assert value == 1
        assert dimensions["Service"] == "tracking"
        assert dimensions["Result"] == "hit"
        assert dimensions["KeyPrefix"] == "tracking:order:v1"
        assert "secret-sub" not in str(dimensions)
        assert "usr_secret" not in str(dimensions)

    def test_a_miss_publishes_result_miss(self) -> None:
        publisher = RecordingPublisher()
        gateway = CacheGateway(
            client=fakeredis.FakeRedis(decode_responses=True), metrics=publisher
        )
        gateway.get("tracking:list:v1:s:u:abcd")
        assert publisher.data[0][2]["Result"] == "miss"

    def test_a_bypass_publishes_result_bypass(self) -> None:
        publisher = RecordingPublisher()
        gateway = CacheGateway(client=ExplodingRedis(), metrics=publisher)
        gateway.get("tracking:order:v1:s:u:ord_1")
        results = [
            d[2]["Result"] for d in publisher.data if d[0] == "cache_requests_total"
        ]
        assert results == ["bypass"]

    def test_duration_is_published_per_operation(self) -> None:
        publisher = RecordingPublisher()
        gateway = CacheGateway(
            client=fakeredis.FakeRedis(decode_responses=True), metrics=publisher
        )
        gateway.set("tracking:order:v1:s:u:ord_1", {"a": 1}, 60)
        gateway.get("tracking:order:v1:s:u:ord_1")

        durations = [
            d for d in publisher.data if d[0] == "cache_operation_duration_ms"
        ]
        operations = {d[2]["Operation"] for d in durations}
        assert operations == {"get", "set"}
        assert all(d[2]["Service"] == "tracking" for d in durations)


class TestTelemetryNeverCarriesAFullKey:
    """A full key embeds `cognito_sub` and `user_id`. Neither may be exported.

    Asserted against the REAL exported spans and the REAL log records rather
    than by reading the source: a grep proves what the code says today, and the
    rule needs to survive an edit by someone who has not read the module
    docstring. A span attribute, a CloudWatch dimension value and a log field
    are all export destinations, so all three are checked.
    """

    SECRET_SUB = "11111111-1111-4111-8111-111111111111"
    SECRET_USER = "usr_supersecretuserid00"

    def _key(self) -> str:
        return f"tracking:order:v1:{self.SECRET_SUB}:{self.SECRET_USER}:ord_1"

    def test_no_span_attribute_carries_the_sub_or_the_user_id(self) -> None:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import (
            InMemorySpanExporter,
        )

        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(SimpleSpanProcessor(exporter))

        # The gateway holds its tracer at import time, so the provider is
        # swapped on the module's own tracer rather than globally — patching
        # `trace.set_tracer_provider` would be ignored by an already-built one.
        import src.shared.cache.gateway as gateway_module

        original = gateway_module._tracer
        gateway_module._tracer = provider.get_tracer("tracking-cache-test")
        try:
            gateway = CacheGateway(
                client=fakeredis.FakeRedis(decode_responses=True),
                metrics=NoopMetricsPublisher(),
            )
            key = self._key()
            gateway.set(key, {"a": 1}, 60, index_key="tracking:index:v1:s:u")
            gateway.get(key)
            gateway.invalidate(key)
            gateway.invalidate_index("tracking:index:v1:s:u")
        finally:
            gateway_module._tracer = original
            trace  # noqa: B018 - imported for the symbol's side-effect-free use

        spans = exporter.get_finished_spans()
        assert spans, "no spans were exported"
        for span in spans:
            rendered = str(dict(span.attributes or {}))
            assert self.SECRET_SUB not in rendered, span.name
            assert self.SECRET_USER not in rendered, span.name
            assert "ord_1" not in rendered, span.name

    def test_no_metric_dimension_carries_the_sub_or_the_user_id(self) -> None:
        publisher = RecordingPublisher()
        gateway = CacheGateway(
            client=fakeredis.FakeRedis(decode_responses=True), metrics=publisher
        )
        key = self._key()
        gateway.set(key, {"a": 1}, 60)
        gateway.get(key)
        gateway.invalidate(key)

        assert publisher.data, "no metrics were published"
        for name, _value, dimensions in publisher.data:
            rendered = str(dimensions)
            assert self.SECRET_SUB not in rendered, name
            assert self.SECRET_USER not in rendered, name

    def test_no_log_record_carries_the_sub_or_the_user_id(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        """The two lines the cache can emit: unavailable, and unreadable."""
        key = self._key()
        with caplog.at_level("WARNING", logger="src.shared.cache.gateway"):
            broken = CacheGateway(
                client=ExplodingRedis(), metrics=NoopMetricsPublisher()
            )
            broken.get(key)
            broken.set(key, {"a": 1}, 60)
            broken.invalidate(key)

            corrupt_client = fakeredis.FakeRedis(decode_responses=True)
            corrupt_client.set(key, "{not json")
            CacheGateway(
                client=corrupt_client, metrics=NoopMetricsPublisher()
            ).get(key)

        assert caplog.records, "no log records were emitted"
        for record in caplog.records:
            rendered = f"{record.getMessage()} {record.__dict__}"
            assert self.SECRET_SUB not in rendered
            assert self.SECRET_USER not in rendered
