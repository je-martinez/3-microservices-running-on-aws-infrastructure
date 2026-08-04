"""The Alembic migration must produce exactly the models' schema.

The repository suite builds its schema from `Base.metadata`, so on its own it
would happily pass against models that have drifted away from the migration —
and the migration is what actually runs in every real environment. This test
closes that gap: it applies the migration to a scratch database and asserts
Alembic detects no difference against the models.
"""

import subprocess
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

pytestmark = pytest.mark.integration

SERVICE_ROOT = Path(__file__).resolve().parents[1]

# Tables this suite owns and may drop/recreate.
MANAGED_TABLES = ("tracking_history", "tracking", "alembic_version")


@pytest.fixture
def scratch_database_url(database_url: str, engine) -> str:
    """The `tracking` database itself, emptied of its tables around each test.

    NOT a throwaway database: Floci's MySQL grants `test` no CREATE DATABASE
    privilege (it cannot manage users or databases at all — a known limitation of
    this local stack), so `CREATE DATABASE tracking_migration_check` fails with
    error 1044. Running against the real database and restoring the schema
    afterwards is the only option that still exercises the migration for real.

    The `engine` fixture is requested so the session-scoped schema is rebuilt from
    the models after this test has torn it down — otherwise a repository test
    running later would find no tables.
    """
    scratch = create_engine(database_url)
    _drop_managed_tables(scratch)

    yield database_url

    # Restore the models' schema for the rest of the session.
    _drop_managed_tables(scratch)
    from src.shared.db.base import Base

    Base.metadata.create_all(scratch)
    scratch.dispose()


def _drop_managed_tables(engine_) -> None:
    with engine_.begin() as conn:
        conn.execute(text("SET FOREIGN_KEY_CHECKS=0"))
        for table in MANAGED_TABLES:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
        conn.execute(text("SET FOREIGN_KEY_CHECKS=1"))


def run_alembic(*args: str, url: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(SERVICE_ROOT / ".venv" / "bin" / "alembic"), *args],
        cwd=SERVICE_ROOT,
        env={"PATH": "/usr/bin:/bin", "TRACKING_TEST_DATABASE_URL": url},
        capture_output=True,
        text=True,
        timeout=120,
    )


def test_upgrade_head_applies_cleanly(scratch_database_url: str) -> None:
    result = run_alembic("upgrade", "head", url=scratch_database_url)
    assert result.returncode == 0, result.stderr


def test_migration_matches_the_models(scratch_database_url: str) -> None:
    """`alembic check` reports drift between the migrated schema and the models."""
    upgrade = run_alembic("upgrade", "head", url=scratch_database_url)
    assert upgrade.returncode == 0, upgrade.stderr

    check = run_alembic("check", url=scratch_database_url)
    assert check.returncode == 0, (
        "migration has drifted from the models — regenerate it:\n"
        f"{check.stdout}\n{check.stderr}"
    )
    assert "No new upgrade operations detected" in check.stdout


def test_downgrade_removes_both_tables(scratch_database_url: str) -> None:
    """Downgrade must be reversible — the rollback path, not just the forward one."""
    run_alembic("upgrade", "head", url=scratch_database_url)
    result = run_alembic("downgrade", "base", url=scratch_database_url)
    assert result.returncode == 0, result.stderr

    scratch = create_engine(scratch_database_url)
    with scratch.connect() as conn:
        remaining = {row[0] for row in conn.execute(text("SHOW TABLES")).fetchall()}
    scratch.dispose()
    assert "tracking" not in remaining
    assert "tracking_history" not in remaining
