"""Environment configuration, validated at import time.

Parity with the Users service's Zod convention
(`services/users/src/shared/config/env.ts`):
the process refuses to start with an invalid environment rather than failing later
at the first query. Every name here is produced by
`infra/environments/local/scripts/generate_env_files.py` into `.env.local.tracking`
— do not rename a field without changing the generator.
"""

import os
from functools import lru_cache
from typing import Literal

from pydantic import Field, TypeAdapter, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

#: Coerces an environment string to a bool exactly as a `bool` field would.
_BOOL = TypeAdapter(bool)

#: Seconds between two ticks of the periodic metrics publisher. Declared here
#: rather than inline on the field so the field and the environment-reading
#: helper below cannot drift to different defaults.
DEFAULT_METRICS_INTERVAL_SECONDS = 15.0


class Settings(BaseSettings):
    """Validated environment for the Tracking service."""

    model_config = SettingsConfigDict(
        # Compose supplies the environment via `env_file:`; the local `.env` read
        # here is only a developer convenience when running uvicorn/pytest
        # straight off the host.
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        # Tracking's env file also carries AWS_*/OTEL_* keys consumed by the SDKs
        # directly, not by this model. Ignoring extras keeps them from failing
        # validation while still validating everything declared below.
        extra="ignore",
    )

    # --- database (ADR-0006: reads on the reader, writes on the writer) ------
    # SQLAlchemy DSNs, `mysql+pymysql://...`. Locally both point at the same
    # Floci MySQL — Floci emulates no read replica — but the split is honored in
    # code so local and prod behave identically.
    database_writer_url: str = Field(min_length=1)
    database_reader_url: str = Field(min_length=1)

    # --- HTTP ---------------------------------------------------------------
    port: int = Field(default=8000, gt=0, lt=65536)

    # --- gRPC (OUTBOUND only) ------------------------------------------------
    # Tracking serves no gRPC: the server surface was removed in JE-108. What is
    # left points outward, to Users.
    #
    # INTERNAL service-to-service key (ADR-0003), shared with Users and Orders.
    # PRESENTED, never validated: the outbound Users client attaches it as
    # `x-api-key` metadata (JE-101). Nothing inbound checks it any more — the
    # carrier PUT has its own, external key below.
    grpc_api_key: str = Field(min_length=1)

    # Where Users' gRPC server lives, for the OUTBOUND client that resolves a
    # Cognito sub to the internal `usr_` id (JE-101) — the same value Orders
    # receives under this exact name (`USERS_GRPC_URL=http://users:50051` in
    # `generate_env_files.py`).
    #
    # DEFAULTED, unlike every other gRPC setting here, and deliberately: the
    # generator does NOT currently write this key into `.env.local.tracking`
    # (only into `.env.local.orders`), and env files are generated, never
    # hand-edited ([[env-files]]). A required field would therefore refuse to
    # start the service the moment this lands, for a reason that lives in
    # `infra/**` — outside this service's change. The default is the compose
    # service name, which is exactly what the generator would emit, so local
    # behavior is identical either way; a deployed environment overrides it.
    #
    # Note this is a bare `host:port` target for `grpc.insecure_channel`, not a
    # URL — Orders' .NET channel takes `http://users:50051` because
    # `GrpcChannel.ForAddress` wants a scheme, while grpcio does not. The client
    # normalizes a scheme away if one is present; see `users_client.py`.
    users_grpc_url: str = Field(default="users:50051", min_length=1)

    # --- carrier webhook ----------------------------------------------------
    # EXTERNAL key issued to the third-party carrier for
    # PUT /v1/trackings/{orderId}/status. Deliberately a DIFFERENT value from
    # grpc_api_key: reusing the internal credential would hand an outside vendor
    # the ability to authenticate as an internal service. See the design's
    # "Auth schemes" section.
    tracking_carrier_api_key: str = Field(min_length=1)

    # --- events pipeline (outbound SQS) --------------------------------------
    # The ONE shared queue all three producers write to. Tracking publishes
    # TRACKING_STATUS_CHANGED here on every delivery-status transition; Users
    # and Orders publish USER_CREATED/ORDER_CREATED to the same URL.
    #
    # DEFAULTED to empty, unlike `database_writer_url`, and the direction is
    # deliberate. The generator DOES write this key
    # (`EVENTS_QUEUE_URL` in `generate_env_files.py`), so a real runtime always
    # has it — but a required field would make every context that constructs
    # `Settings` by hand (the REST test fixtures, which pass only the four
    # values their surface needs) fail on a variable that has nothing to do with
    # what they test. `shared_event_publisher()` is only ever reached with a
    # real environment, and an empty URL fails there, loudly, at the one call
    # site that actually needs it — rather than refusing to start the service.
    events_queue_url: str = ""

    # Where the AWS SDK should point. Locally this is Floci
    # (`http://floci:4566`); in a deployed environment it is unset and boto3
    # resolves the real endpoint itself, which is why the default is None rather
    # than a literal.
    #
    # Both of these were previously absorbed by `extra="ignore"` — the env file
    # has always carried them for the SDKs to read directly. They are declared
    # now because the SQS client is constructed in code
    # (`shared/messaging/sqs_event_publisher.py`) and needs the values, and a
    # declared field is what `test_settings.py` can pin against a generator
    # rename.
    aws_endpoint_url: str | None = None
    aws_region: str = "us-east-1"

    # --- custom business metrics (CloudWatch) --------------------------------
    # Seconds between two ticks of the periodic gauge publisher
    # (`features/tracking/commands/publish_metrics.py`). 15s locally; real AWS
    # uses 60s.
    #
    # DEFAULTED, like everything optional here, and for the reason recorded at
    # the top of this module: every name in this class is emitted into
    # `.env.local.tracking` by `generate_env_files.py`, and a required field with
    # no default would refuse to start for anyone who has not regenerated their
    # env file.
    metrics_interval_seconds: float = DEFAULT_METRICS_INTERVAL_SECONDS

    # Whether the periodic publisher runs at all. ON by default so a real
    # runtime publishes without opting in; the test environment turns it OFF
    # (see `metrics_enabled()` below) because `create_app()` is built by every
    # REST test and `TestClient` enters the lifespan — an ungated task would open
    # a real database session and reach for CloudWatch on every test run.
    metrics_enabled: bool = True

    # --- E2E test harness ----------------------------------------------------
    # Gates the flag-guarded cleanup route (`DELETE /v1/trackings/e2e-cleanup`),
    # the same name and the same meaning Users and Orders already read
    # (`E2E_TESTING_ENABLED=true` in their `.env.local.*`).
    #
    # DEFAULTS TO FALSE, and that direction is the point: a deployed environment
    # that simply never sets the variable does not serve the route at all, so a
    # forgotten env value cannot expose a mass-delete surface in production. The
    # generator does not currently write this key into `.env.local.tracking` —
    # that is an `infra/**` change, outside this service — so locally it is opted
    # into explicitly, exactly like `users_grpc_url` above.
    #
    # `bool` rather than a string: pydantic-settings parses the usual env
    # spellings ("true"/"1"/"yes") itself, so nothing here reimplements Users'
    # Zod `.enum(["true","false"]).transform(...)` by hand.
    e2e_testing_enabled: bool = False

    # --- cache ---------------------------------------------------------------
    # Redis/Valkey backing the response cache. REDIS_HOST is the
    # floci-valkey-<id> CONTAINER NAME on the Docker network, never "localhost"
    # (from inside this container that IS this container); REDIS_PORT is the
    # backing container's own port, not the host-side proxy port the ElastiCache
    # API reports. Both are written by `make env-file` from Terraform outputs.
    #
    # Defaulted rather than required: the cache is optional by design (it fails
    # open), and `test_openapi_spec.py` builds the app with no environment at
    # all. A required field here would break that.
    redis_host: str = "localhost"
    redis_port: int = Field(default=6379, gt=0, lt=65536)

    # Kill switch for the response cache. False skips the interceptor entirely —
    # no Redis call, and no X-Cache header at all.
    cache_enabled: bool = True

    # --- misc ---------------------------------------------------------------
    deployment_environment: str = "local"
    environment: Literal["development", "test", "production"] = "development"

    @property
    def echo_sql(self) -> bool:
        """Emit SQL only outside production."""
        return self.environment != "production"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Process-wide settings singleton.

    Cached so the environment is parsed (and validated) exactly once. Tests that
    need a different environment call `get_settings.cache_clear()`.
    """
    return Settings()  # type: ignore[call-arg]


def metrics_enabled() -> bool:
    """Whether the periodic metrics publisher should be started.

    Read from the environment DIRECTLY rather than through `get_settings()`, for
    exactly the same reason `e2e_testing_enabled()` is: this is consulted while
    the application is STARTING UP, and `Settings()` raises `ValidationError` on
    an incomplete environment. The whole REST test suite builds the app without
    the DB/gRPC/carrier variables, so going through the model here would make the
    lifespan — and therefore every `TestClient` — depend on a fully-valid
    environment.

    The `metrics_enabled` field on `Settings` above is still the DECLARATION of
    the variable (its name, type and default, pinned by `test_settings.py`); this
    is the one caller that cannot afford to validate everything else to read it.

    Defaults to **True** when the variable is absent — the opposite direction
    from `e2e_testing_enabled()`, and deliberately so: publishing a metric is
    harmless, while forgetting the variable in a deployed environment would leave
    the dashboards silently empty. The test suite opts OUT explicitly
    (`METRICS_ENABLED=false` in `tests/conftest.py`). An unparseable value is
    treated as ON for the same reason a malformed flag must not take a runtime
    down.
    """
    raw = os.environ.get("METRICS_ENABLED")
    if raw is None or raw == "":
        return True
    try:
        return _BOOL.validate_python(raw)
    except ValidationError:
        return True


def metrics_interval_seconds() -> float:
    """The gauge publisher's tick interval, read directly from the environment.

    Same rationale as `metrics_enabled()`: consulted at startup, where a full
    `Settings()` validation is not available. Falls back to the field's own
    default when the variable is absent or unparseable — a malformed interval is
    not a reason to refuse to boot.
    """
    raw = os.environ.get("METRICS_INTERVAL_SECONDS")
    if not raw:
        return DEFAULT_METRICS_INTERVAL_SECONDS
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_METRICS_INTERVAL_SECONDS


def e2e_testing_enabled() -> bool:
    """Whether the flag-guarded E2E routes should be mounted.

    Read from the environment DIRECTLY rather than through `get_settings()`, for
    the same reason `create_app` reads `DEPLOYMENT_ENVIRONMENT` that way: this is
    consulted while the application is being CONSTRUCTED, and `Settings()` raises
    `ValidationError` on an incomplete environment. The test suite builds the app
    deliberately without the DB/gRPC/carrier variables, so going through the model
    here would make constructing an app depend on a fully-valid environment — a
    dependency the factory does not otherwise have, introduced by a test-only
    route.

    The field on `Settings` above is still the declaration of the variable (its
    name, type and default, pinned by `test_settings.py`); this is the one caller
    that cannot afford to validate everything else to read it.

    Parsing goes through pydantic's `bool` adapter — the same coercion the field
    above would apply — so the two can never disagree about what counts as "on":
    `true/1/yes/on`, case-insensitively. Anything unrecognized, including an empty
    value or an absent variable, is False. The direction of that default is the
    safety property: a runtime that never sets the variable does not serve the
    route.
    """
    raw = os.environ.get("E2E_TESTING_ENABLED")
    if not raw:
        return False
    try:
        return _BOOL.validate_python(raw)
    except ValidationError:
        # An unparseable value ("maybe") is OFF, not a startup failure: refusing
        # to boot production over a malformed test-harness flag would be the worse
        # trade, and OFF is the safe direction.
        return False
