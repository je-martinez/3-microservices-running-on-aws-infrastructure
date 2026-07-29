"""Alembic environment for the Tracking service.

The database URL comes from the environment, never from alembic.ini — migrations
must target whatever `.env.local.tracking` (generated from Terraform outputs)
points at, and Floci reassigns the MySQL proxy port on every apply.

Migrations always run against the **writer**: DDL is a mutation.
"""

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Make `src.…` importable when alembic runs from the service root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.features.tracking.domain import (
    models,  # noqa: E402,F401  (registers the tables)
)
from src.shared.db.base import Base  # noqa: E402

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _database_url() -> str:
    """Resolve the writer URL from the environment.

    `TRACKING_TEST_DATABASE_URL` takes precedence so the test suite can build its
    schema against a throwaway database without touching the service's own env.
    """
    url = os.getenv("TRACKING_TEST_DATABASE_URL") or os.getenv("DATABASE_WRITER_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_WRITER_URL (or TRACKING_TEST_DATABASE_URL) must be set to "
            "run migrations"
        )
    return url


def run_migrations_offline() -> None:
    """Emit SQL to stdout without connecting."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations against a live connection."""
    section = config.get_section(config.config_ini_section, {})
    section["sqlalchemy.url"] = _database_url()

    connectable = engine_from_config(
        section, prefix="sqlalchemy.", poolclass=pool.NullPool
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
