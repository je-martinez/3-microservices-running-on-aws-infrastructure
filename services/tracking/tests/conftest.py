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
from contextlib import contextmanager
from pathlib import Path

import grpc
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
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


@pytest.fixture
def anyio_backend() -> str:
    """Run async tests on asyncio only.

    anyio would otherwise parametrize them across asyncio AND trio. Production
    runs on uvicorn's asyncio loop — and `shared/scheduling/background.py` uses
    `asyncio.run_coroutine_threadsafe` specifically — so a trio run would be
    testing a runtime this service never uses, and failing on APIs it never calls.
    """
    return "asyncio"


# --------------------------------------------------------------------- gRPC
#
# The gRPC tests run against a REAL server over a REAL socket (bound on an
# ephemeral loopback port), with the servicer talking to the same real MySQL the
# repository tests use. Not a mocked `ServicerContext`, and not a direct call into
# the servicer class: a direct call bypasses the interceptor, serialization, and
# status-code mapping — precisely the three things these tests exist to verify.
# The skip property is inherited from `database_url`, so no DB still means an
# explicit skip, never a silent fallback.

#: The `x-api-key` the test server is configured with. A literal, not the real
#: environment's key — these tests must not depend on a generated env file.
TEST_API_KEY = "test-grpc-api-key"


@pytest.fixture
def grpc_server(engine: Engine) -> Iterator[int]:
    """A running gRPC server bound to an ephemeral port; yields that port.

    The servicer's session factories are bound to the TEST engine rather than the
    process-wide writer/reader engines, so the RPCs read and write the same
    database the other fixtures set up and clean.
    """
    from src.features.tracking.grpc.service import TrackingServicer
    from src.shared.grpc.server import build_server

    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    @contextmanager
    def write_session() -> Iterator[Session]:
        """Mirrors `shared.db.engine.write_session`: commits, rolls back, closes."""
        session = factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    @contextmanager
    def read_session() -> Iterator[Session]:
        session = factory()
        try:
            yield session
        finally:
            session.close()

    server = build_server(
        api_key=TEST_API_KEY,
        servicer=TrackingServicer(writer=write_session, reader=read_session),
    )
    # Port 0 = let the OS pick a free one. Hardcoding a port makes the suite fail
    # when anything else on the machine happens to hold it.
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield port
    finally:
        # No grace period: every RPC in this suite is complete by teardown, and a
        # grace window would just slow the run down.
        server.stop(None).wait()


@pytest.fixture
def grpc_channel(grpc_server: int) -> Iterator[grpc.Channel]:
    """An insecure channel to the test server."""
    with grpc.insecure_channel(f"127.0.0.1:{grpc_server}") as channel:
        yield channel


@pytest.fixture
def session_factory(engine: Engine):
    """A `write_session`-shaped factory bound to the TEST engine.

    Extracted so the TestMode suite can hand the same factory to the progression,
    which opens a session of its own per transition (the creating request's is long
    closed by then).
    """
    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    @contextmanager
    def write_session() -> Iterator[Session]:
        session = factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    return write_session


# --------------------------------------------------------------------- HTTP
#
# The REST tests drive the REAL FastAPI app (built by `create_app`) through
# `TestClient`, against the SAME real MySQL every other suite uses. Not a mocked
# handler and not a hand-called function: going through the app is what exercises
# the routing, the auth dependencies, the Pydantic response models and the
# exception handlers — the four things a direct call would skip, and three of them
# (auth, ownership scoping, the 400 `reason` field) are the point of Phase D.
#
# The skip property is inherited from `database_url`: no MySQL still means an
# explicit skip, never a fallback to mocks.

#: The carrier key the test app is configured with. A literal, not the real
#: environment's key — these tests must not depend on a generated env file.
TEST_CARRIER_API_KEY = "test-carrier-api-key"


@pytest.fixture
def app(engine: Engine) -> FastAPI:
    """The real app, with its DB sessions and settings bound to the test engine.

    Three overrides, each replacing a process-wide singleton with a test-scoped
    one:

    * `get_read_session` / `get_write_session` — sessions on the TEST engine, so
      the HTTP surface reads and writes the same database the other fixtures set up
      and clean. The write override commits, exactly as `write_session` does, so a
      test can assert the row survived the request rather than only the response.
    * `get_settings` — a settings object whose `tracking_carrier_api_key` is the
      literal above, so the carrier tests neither read nor need a real env file.

    The gRPC server is disabled for this app (`TRACKING_GRPC_ENABLED=0` is set by
    the fixture below): the HTTP suite has no business binding GRPC_PORT, and the
    gRPC surface already has its own suite on an ephemeral port.
    """
    from src.main import create_app
    from src.shared.config.settings import Settings, get_settings
    from src.shared.http.dependencies import get_read_session, get_write_session

    factory = sessionmaker(bind=engine, expire_on_commit=False, future=True)

    def override_read() -> Iterator[Session]:
        db = factory()
        try:
            yield db
        finally:
            db.close()

    def override_write() -> Iterator[Session]:
        db = factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def override_settings() -> Settings:
        return Settings(
            database_writer_url="mysql+pymysql://unused/unused",
            database_reader_url="mysql+pymysql://unused/unused",
            grpc_api_key="unused-grpc-key",
            tracking_carrier_api_key=TEST_CARRIER_API_KEY,
        )

    application = create_app()
    application.dependency_overrides[get_read_session] = override_read
    application.dependency_overrides[get_write_session] = override_write
    application.dependency_overrides[get_settings] = override_settings
    return application


@pytest.fixture
def client(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    """A `TestClient` over the real app, with the gRPC server switched off.

    `TestClient` as a context manager RUNS the lifespan — which is deliberate: it
    means the startup path Phase D added is exercised on every REST test rather
    than only in production. `TRACKING_GRPC_ENABLED=0` keeps that startup from
    binding a second port, which would fail the moment two tests overlapped or the
    real service was already running locally.
    """
    from src.main import GRPC_ENABLED_ENV

    monkeypatch.setenv(GRPC_ENABLED_ENV, "0")
    with TestClient(app) as test_client:
        yield test_client
