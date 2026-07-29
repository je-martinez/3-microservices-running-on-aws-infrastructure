"""Environment configuration, validated at import time.

Parity with the Users service's Zod convention
(`services/users/src/shared/config/env.ts`):
the process refuses to start with an invalid environment rather than failing later
at the first query. Every name here is produced by
`infra/environments/local/scripts/generate_env_files.py` into `.env.local.tracking`
— do not rename a field without changing the generator.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # --- gRPC ---------------------------------------------------------------
    # 50051 is Users' gRPC server, so Tracking's serves on 50052.
    grpc_port: int = Field(default=50052, gt=0, lt=65536)
    # INTERNAL service-to-service key (ADR-0003), shared with Users and Orders.
    grpc_api_key: str = Field(min_length=1)

    # --- carrier webhook ----------------------------------------------------
    # EXTERNAL key issued to the third-party carrier for
    # PUT /v1/trackings/{orderId}/status. Deliberately a DIFFERENT value from
    # grpc_api_key: reusing the internal credential would hand an outside vendor
    # the ability to authenticate as an internal service. See the design's
    # "Auth schemes" section.
    tracking_carrier_api_key: str = Field(min_length=1)

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
