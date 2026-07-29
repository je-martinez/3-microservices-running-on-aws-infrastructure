"""Settings validation (parity with the Users service's Zod convention).

The point of these tests is that the process refuses to start on a bad
environment, instead of starting and failing later at the first query. They also
pin the exact env var NAMES the generator writes into `.env.local.tracking` — a
rename on either side breaks the service silently, so it breaks here first.
"""

import os
from collections.abc import Iterator

import pytest
from pydantic import ValidationError

from src.shared.config.settings import Settings

MINIMAL_ENV = {
    "DATABASE_WRITER_URL": "mysql+pymysql://test:test@floci:7001/tracking",
    "DATABASE_READER_URL": "mysql+pymysql://test:test@floci:7001/tracking",
    "GRPC_API_KEY": "internal-key",
    "TRACKING_CARRIER_API_KEY": "external-carrier-key",
}

# Names the settings model reads. Cleared before each test so a developer's real
# shell environment cannot make a "required var missing" test pass spuriously.
MANAGED_KEYS = (
    *MINIMAL_ENV,
    "PORT",
    "GRPC_PORT",
    "USERS_GRPC_URL",
    "ENVIRONMENT",
    "DEPLOYMENT_ENVIRONMENT",
)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for key in MANAGED_KEYS:
        monkeypatch.delenv(key, raising=False)
    yield


def build(env: dict[str, str] | None = None, **overrides: str) -> Settings:
    """Construct Settings from the real process environment.

    Goes through `os.environ` rather than passing kwargs: pydantic-settings maps
    constructor kwargs to FIELD names (lowercase), so passing `DATABASE_WRITER_URL=`
    would be ignored as an extra and the required field would read as missing.
    Setting real env vars is also what the service actually does at boot, so this
    exercises the mechanism under test instead of a shortcut around it.
    """
    source = {**MINIMAL_ENV, **(env or {}), **overrides}
    for key, value in source.items():
        os.environ[key] = value
    # _env_file=None so a developer's real .env never leaks into these assertions.
    return Settings(_env_file=None)  # type: ignore[call-arg]


class TestRequiredVars:
    def test_minimal_environment_is_valid(self) -> None:
        settings = build()
        assert settings.database_writer_url.startswith("mysql+pymysql://")

    @pytest.mark.parametrize("missing", sorted(MINIMAL_ENV))
    def test_each_required_var_is_actually_required(self, missing: str) -> None:
        for key, value in MINIMAL_ENV.items():
            if key != missing:
                os.environ[key] = value
        with pytest.raises(ValidationError, match=missing.lower()):
            Settings(_env_file=None)  # type: ignore[call-arg]

    @pytest.mark.parametrize(
        "key", ["GRPC_API_KEY", "TRACKING_CARRIER_API_KEY"]
    )
    def test_empty_api_keys_are_rejected(self, key: str) -> None:
        """An empty key would deploy the surface unguarded by omission."""
        with pytest.raises(ValidationError):
            build(**{key: ""})


class TestDefaults:
    def test_port_defaults_to_uvicorn_s_8000(self) -> None:
        """3000 and 8080 are taken by Users and Orders."""
        assert build().port == 8000

    def test_grpc_port_defaults_to_50052(self) -> None:
        """50051 is Users' gRPC server."""
        assert build().grpc_port == 50052

    def test_ports_are_coerced_from_strings(self) -> None:
        """Environment values always arrive as strings."""
        settings = build(PORT="9000", GRPC_PORT="50999")
        assert settings.port == 9000
        assert settings.grpc_port == 50999

    @pytest.mark.parametrize("bad", ["0", "70000", "not-a-port"])
    def test_invalid_ports_are_rejected(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            build(PORT=bad)


class TestTrustDomains:
    def test_the_two_keys_are_independent_fields(self) -> None:
        """The internal gRPC key and the external carrier key must never be one value.

        Reusing the internal service credential as the externally-distributed
        carrier key would hand an outside vendor the ability to authenticate as an
        internal service.
        """
        settings = build(
            GRPC_API_KEY="internal", TRACKING_CARRIER_API_KEY="external"
        )
        assert settings.grpc_api_key == "internal"
        assert settings.tracking_carrier_api_key == "external"


class TestUsersGrpcUrl:
    """The OUTBOUND target for the Users client (JE-101)."""

    def test_defaults_to_the_compose_service_name(self) -> None:
        """Defaulted on purpose: the env generator does NOT write this key into
        `.env.local.tracking` yet (only into `.env.local.orders`), and env files
        are generated, never hand-edited. A required field would refuse to start
        the service for a reason living in `infra/**`.
        """
        assert build().users_grpc_url == "users:50051"

    def test_is_overridable_from_the_environment(self) -> None:
        """Under the SAME name Orders reads, so one value serves both services."""
        assert (
            build(USERS_GRPC_URL="http://users:50051").users_grpc_url
            == "http://users:50051"
        )

    def test_an_empty_value_is_rejected(self) -> None:
        """Blank would resolve to an empty gRPC target and fail at first call."""
        with pytest.raises(ValidationError):
            build(USERS_GRPC_URL="")


class TestReplicaSplit:
    def test_writer_and_reader_are_separate_fields(self) -> None:
        """ADR-0006: same value locally, distinct endpoints in prod."""
        settings = build(
            DATABASE_WRITER_URL="mysql+pymysql://w/tracking",
            DATABASE_READER_URL="mysql+pymysql://r/tracking",
        )
        assert settings.database_writer_url != settings.database_reader_url


class TestExtraVars:
    def test_aws_and_otel_vars_do_not_fail_validation(self) -> None:
        """The env file carries keys consumed by the SDKs, not by this model."""
        settings = build(
            AWS_REGION="us-east-1",
            OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:4318",
            OTEL_METRICS_EXPORTER="none",
        )
        assert settings.port == 8000
