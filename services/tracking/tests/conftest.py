"""Shared test fixtures.

Repository tests run against a **real MySQL**, never mocks and never SQLite. This
repo has a standing lesson that mocked persistence tests pass while the real
schema/driver rejects the write — a JSON column, a composite PK and a unique
constraint are exactly the things a mock cannot check, and SQLite's dialect
differs enough from MySQL's to give a false pass of its own.

The Floci MySQL proxy port is **discovered**, not hardcoded: Floci assigns ports
7000-7099 by cluster creation order, which is not stable across applies.
"""

import os
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from src.shared.db.base import Base

# services/tracking/tests/conftest.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]

#: The Floci MySQL container, per the local infra setup.
MYSQL_CONTAINER = "floci-rds-mysql-3mrai-local-orders-db-aurora"


def _discover_mysql_port() -> int | None:
    """Ask Floci which port it assigned the MySQL cluster.

    Reuses `infra/scripts/lib3mrai/db.discover_port` — the repo's single
    discovery mechanism — rather than re-deriving it. Returns None when Floci is
    not up or boto3 is unavailable, so the suite can skip with a clear message
    instead of erroring.
    """
    override = os.getenv("TRACKING_TEST_MYSQL_PORT")
    if override:
        return int(override)

    infra_scripts = REPO_ROOT / "infra" / "scripts"
    venv_python = REPO_ROOT / ".venv" / "bin" / "python"
    if not venv_python.exists() or not infra_scripts.exists():
        return None

    # Run in the INFRA venv (which has boto3), not this service's venv, by
    # absolute path — the ambient `python3` may resolve into an unrelated venv.
    probe = (
        f"import sys; sys.path.insert(0, {str(infra_scripts)!r})\n"
        "from lib3mrai import db\n"
        "print(db.discover_port('mysql'))\n"
    )
    try:
        result = subprocess.run(
            [str(venv_python), "-c", probe],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def _database_url() -> str | None:
    """Resolve the test database URL, or None when no real MySQL is reachable."""
    explicit = os.getenv("TRACKING_TEST_DATABASE_URL")
    if explicit:
        return explicit

    port = _discover_mysql_port()
    if port is None:
        return None
    # 127.0.0.1, not localhost: Floci publishes the proxy port on the host, and
    # `localhost` can resolve to ::1, where nothing is listening.
    return (
        f"mysql+pymysql://test:test@127.0.0.1:{port}/tracking?charset=utf8mb4"
    )


@pytest.fixture(scope="session")
def database_url() -> str:
    """The real-MySQL URL, or skip the whole integration suite explaining why."""
    url = _database_url()
    if url is None:
        pytest.skip(
            "no real MySQL reachable — set TRACKING_TEST_DATABASE_URL, or bring "
            "Floci up (`make bootstrap`) so the port can be discovered. "
            "These tests deliberately do NOT fall back to mocks or SQLite: a "
            "mocked repository test cannot catch a schema or driver bug.",
            allow_module_level=False,
        )
    return url


@pytest.fixture(scope="session")
def engine(database_url: str) -> Iterator[Engine]:
    """Session-wide engine, with the schema created from the models' metadata.

    The tables are created (and dropped) here rather than via `alembic upgrade
    head` so a schema drift between the models and the migration cannot make these
    tests pass against the migration's shape. The migration is verified separately
    in `test_migration.py`.
    """
    eng = create_engine(database_url, pool_pre_ping=True, future=True)

    # Fail loudly and early if the database is not actually reachable, rather
    # than letting every test fail with the same connection error.
    try:
        with eng.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001 - reported as a skip, not swallowed
        eng.dispose()
        pytest.skip(f"MySQL at {database_url.rsplit('@', 1)[-1]} unreachable: {exc}")

    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture
def session(engine: Engine) -> Iterator[Session]:
    """A clean session per test.

    Every test starts from empty tables: `tracking.order_id` is UNIQUE, so leaked
    rows from a previous test would turn a real failure into a confusing
    integrity error somewhere else.
    """
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)
    with factory() as session:
        # Children first — tracking_history has an FK to tracking.
        session.execute(text("DELETE FROM tracking_history"))
        session.execute(text("DELETE FROM tracking"))
        session.commit()
        yield session
        session.rollback()


def pytest_configure(config: pytest.Config) -> None:
    """Make `src.…` importable without installing the service as a package."""
    service_root = str(Path(__file__).resolve().parents[1])
    if service_root not in sys.path:
        sys.path.insert(0, service_root)
