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

from src.shared.config.settings import Settings, e2e_testing_enabled

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
    "E2E_TESTING_ENABLED",
    # Cleared like every other managed key, and load-bearing here: the test
    # suite sets METRICS_ENABLED=false process-wide (tests/conftest.py) so the
    # lifespan starts no publisher, which would otherwise make these tests read
    # that value instead of the field's own default.
    "METRICS_ENABLED",
    "METRICS_INTERVAL_SECONDS",
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
        """An empty key fails at the wrong time if it is allowed through here.

        `TRACKING_CARRIER_API_KEY` empty would leave a state-mutating endpoint
        unguarded by omission; `GRPC_API_KEY` empty would be sent to Users as an
        empty `x-api-key` and rejected there, turning a local misconfiguration into
        a runtime failure that names the wrong service.
        """
        with pytest.raises(ValidationError):
            build(**{key: ""})


class TestDefaults:
    def test_port_defaults_to_uvicorn_s_8000(self) -> None:
        """3000 and 8080 are taken by Users and Orders."""
        assert build().port == 8000

    def test_the_port_is_coerced_from_a_string(self) -> None:
        """Environment values always arrive as strings."""
        assert build(PORT="9000").port == 9000

    @pytest.mark.parametrize("bad", ["0", "70000", "not-a-port"])
    def test_invalid_ports_are_rejected(self, bad: str) -> None:
        with pytest.raises(ValidationError):
            build(PORT=bad)

    def test_there_is_no_grpc_port_to_serve_on(self) -> None:
        """Tracking binds no gRPC port: the server was removed in JE-108.

        `GRPC_PORT` is still written into `.env.local.tracking` by the generator in
        `infra/**`, which is out of this service's reach — `extra="ignore"` is what
        keeps that leftover from failing validation. Asserting the field's ABSENCE
        rather than just deleting the old test: a `grpc_port` reappearing would mean
        something re-acquired a served surface.
        """
        assert "grpc_port" not in Settings.model_fields

    def test_a_leftover_grpc_port_in_the_environment_is_harmless(self) -> None:
        """The generator still emits it; the service must start anyway."""
        assert build(GRPC_PORT="50052").port == 8000


class TestTrustDomains:
    def test_the_two_keys_are_independent_fields(self) -> None:
        """The internal gRPC key and the external carrier key must never be one value.

        Reusing the internal service credential as the externally-distributed
        carrier key would hand an outside vendor a credential that authenticates as
        an internal service against every gRPC surface in the mesh — Users' and
        Orders', even though Tracking itself no longer serves one.
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


class TestE2eTestingEnabled:
    """The flag gating `DELETE /v1/trackings/e2e-cleanup` (JE-111).

    The default direction is the safety property: a deployed environment that
    never sets the variable does not serve a mass soft-delete route.
    """

    def test_defaults_to_false(self) -> None:
        assert build().e2e_testing_enabled is False

    @pytest.mark.parametrize("truthy", ["true", "True", "1", "yes", "on"])
    def test_the_usual_true_spellings_are_accepted(self, truthy: str) -> None:
        """The same name and value Users and Orders read (`"true"` in the env files)."""
        assert build(E2E_TESTING_ENABLED=truthy).e2e_testing_enabled is True

    @pytest.mark.parametrize("falsy", ["false", "False", "0", "no", "off"])
    def test_the_usual_false_spellings_are_rejected(self, falsy: str) -> None:
        assert build(E2E_TESTING_ENABLED=falsy).e2e_testing_enabled is False


class TestE2eTestingEnabledHelper:
    """`e2e_testing_enabled()` — the mount-time reader used by `create_app`.

    It reads the environment DIRECTLY, and that is the behaviour under test: the
    app must be constructible without a valid environment (the whole REST suite
    builds one with no DB/carrier variables), so this must not go through
    `Settings()` and inherit its validation.
    """

    def test_absent_is_false(self) -> None:
        assert e2e_testing_enabled() is False

    def test_empty_is_false(self) -> None:
        """An env file emitting `E2E_TESTING_ENABLED=` must not mount the route."""
        os.environ["E2E_TESTING_ENABLED"] = ""
        assert e2e_testing_enabled() is False

    @pytest.mark.parametrize("truthy", ["true", "True", "1", "yes", "on"])
    def test_true_spellings_enable_it(self, truthy: str) -> None:
        os.environ["E2E_TESTING_ENABLED"] = truthy
        assert e2e_testing_enabled() is True

    @pytest.mark.parametrize("falsy", ["false", "0", "no", "off"])
    def test_false_spellings_do_not(self, falsy: str) -> None:
        os.environ["E2E_TESTING_ENABLED"] = falsy
        assert e2e_testing_enabled() is False

    def test_an_unparseable_value_is_off_rather_than_a_startup_failure(self) -> None:
        """OFF is the safe direction, and refusing to boot is the worse trade.

        A production runtime must not be taken down by a malformed test-harness
        flag, and it must not serve the route on one either.
        """
        os.environ["E2E_TESTING_ENABLED"] = "maybe"
        assert e2e_testing_enabled() is False

    def test_it_does_not_require_a_valid_environment(self) -> None:
        """No DB/gRPC/carrier variables set — the helper still answers.

        `Settings()` would raise here. `create_app()` calls this while building the
        routing table, so if it validated everything else, constructing an app
        would start depending on a full environment because of a test-only route.
        """
        for key in MINIMAL_ENV:
            os.environ.pop(key, None)
        os.environ["E2E_TESTING_ENABLED"] = "true"
        assert e2e_testing_enabled() is True


class TestExtraVars:
    def test_aws_and_otel_vars_do_not_fail_validation(self) -> None:
        """The env file carries keys consumed by the SDKs, not by this model."""
        settings = build(
            AWS_REGION="us-east-1",
            OTEL_EXPORTER_OTLP_ENDPOINT="http://collector:4318",
            OTEL_METRICS_EXPORTER="none",
        )
        assert settings.port == 8000
