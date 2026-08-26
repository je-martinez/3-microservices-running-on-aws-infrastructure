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
from concurrent import futures
from contextlib import contextmanager
from pathlib import Path

import grpc
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from src.features.tracking.domain.models import Tracking
from src.shared.db.base import Base
from src.shared.grpc.generated import users_pb2, users_pb2_grpc
from src.shared.grpc.users_client import UsersGrpcClient

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
    # Deliberately NOT dropping on teardown.
    #
    # This suite runs against the SHARED local `tracking` database — the same one
    # the running service and the gateway E2E suite use — because a mocked
    # repository test cannot catch a schema or driver bug (see `database_url`).
    # A teardown `drop_all` therefore left the local environment with no tables:
    # `init-tracking` answered 500, the E2E suite went red, and the failure
    # looked like a broken feature rather than a test side effect.
    #
    # Worse, it was not self-healing. `drop_all` removes the model tables but not
    # `alembic_version`, which Alembic owns and no model declares — so Alembic
    # still reported the schema as up to date and `make migrate-tracking` became
    # a silent no-op ("applied", nothing applied). Recovery needed dropping
    # `alembic_version` by hand first, which nobody would guess from the symptom.
    #
    # Leaving the schema in place costs nothing: `create_all` is idempotent, the
    # opening `drop_all` above still guarantees a clean shape for THIS run, and
    # the per-test `session` fixture already truncates rows between tests.
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
    """Make `src.…` importable, and keep the metrics publisher out of the suite.

    Two unrelated jobs, both of which must happen before any test module is
    imported:

    * `src.…` importable without installing the service as a package.
    * `METRICS_ENABLED=false`. `create_app()` now installs a lifespan that starts
      the periodic metrics publisher, and `TestClient` is used as a context
      manager (deliberately — see the `client` fixture), which ENTERS that
      lifespan. Left on, every REST test would spawn a loop opening real
      database sessions and reaching for CloudWatch, outside any test's control.
      Set here rather than in a fixture because the flag is read at app startup,
      and `test_settings.py` clears it per test so its own assertions still see
      the field's default.
    """
    service_root = str(Path(__file__).resolve().parents[1])
    if service_root not in sys.path:
        sys.path.insert(0, service_root)

    os.environ.setdefault("METRICS_ENABLED", "false")


@pytest.fixture
def anyio_backend() -> str:
    """Run async tests on asyncio only.

    anyio would otherwise parametrize them across asyncio AND trio. Production
    runs on uvicorn's asyncio loop, and TestMode progression calls `asyncio` APIs
    (`create_task`, `to_thread`) directly, so a trio run would be testing a runtime
    this service never uses and failing on APIs it never calls.
    """
    return "asyncio"


# --------------------------------------------------- stub Users gRPC server
#
# The ONLY gRPC in this suite, matching the only gRPC left in the service: the
# OUTBOUND client to Users. Tracking's own gRPC server — and the fixtures that
# stood one up on an ephemeral port — were removed with it in JE-108.

#: The `x-api-key` the stub Users server expects, and the one the client under test
#: is configured with. A literal, not the real environment's key — these tests must
#: not depend on a generated env file.
TEST_API_KEY = "test-grpc-api-key"


#
# The OUTBOUND client (JE-101) is tested against a REAL `users.v1.Users` server on
# a REAL socket, standing in for the Users service. Not a mocked stub object: a
# mock would return whatever a Python attribute lookup produces, while the things
# worth verifying here — that `x-api-key` reaches the server as metadata, that a
# `context.abort(NOT_FOUND)` arrives as an `RpcError` with that code, that the
# proto fields deserialize onto the right names — all live in the wire round trip
# a mock deletes. Same reasoning as `grpc_server` above, and this one needs no
# database at all, so it never skips.


class StubUsersServicer(users_pb2_grpc.UsersServicer):
    """A minimal `users.v1.Users` server: a dict of known users, plus a call log.

    Records every call it receives so a test can assert on *absence* — the caller
    context's whole contract is that reading the sub causes NO call and that a
    second resolution causes no SECOND call, and both are assertions about the
    number of entries here.
    """

    def __init__(
        self,
        users: dict[str, users_pb2.UserResponse],
        *,
        expected_api_key: str,
    ) -> None:
        self.users = users
        self.expected_api_key = expected_api_key
        #: One `(identifier, api_key)` per received RPC, in order.
        self.calls: list[tuple[str, str | None]] = []

    def GetUserById(self, request, context):  # noqa: N802 - protoc's method name
        api_key = next(
            (
                value
                for key, value in context.invocation_metadata()
                if key == "x-api-key"
            ),
            None,
        )
        self.calls.append((request.id, api_key))
        if api_key != self.expected_api_key:
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "invalid api key")
        user = self.users.get(request.id)
        if user is None:
            context.abort(grpc.StatusCode.NOT_FOUND, "user not found")
        return user


@pytest.fixture
def users_servicer() -> StubUsersServicer:
    """The stub servicer, empty; a test populates `.users` before calling."""
    return StubUsersServicer({}, expected_api_key=TEST_API_KEY)


@pytest.fixture
def users_server(users_servicer: StubUsersServicer) -> Iterator[int]:
    """A running stub Users server on an ephemeral port; yields that port."""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    users_pb2_grpc.add_UsersServicer_to_server(users_servicer, server)
    port = server.add_insecure_port("127.0.0.1:0")
    server.start()
    try:
        yield port
    finally:
        server.stop(None).wait()


@pytest.fixture
def users_client(users_server: int) -> Iterator[UsersGrpcClient]:
    """A `UsersGrpcClient` pointed at the stub server, carrying the valid key."""
    client = UsersGrpcClient.for_target(
        f"127.0.0.1:{users_server}", api_key=TEST_API_KEY
    )
    try:
        yield client
    finally:
        client.close()


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

#: The INTERNAL service key the test app is configured with — a different value in
#: a different trust domain (see `shared/http/internal_auth.py`). Two literals, not
#: one, so a suite can assert that presenting either key on the other's route is
#: rejected; a single shared constant would make that assertion unwritable.
TEST_GRPC_API_KEY = "test-grpc-key"


@pytest.fixture
def app(engine: Engine) -> FastAPI:
    """The real app, with its DB sessions and settings bound to the test engine.

    Three overrides, each replacing a process-wide singleton with a test-scoped
    one:

    * `get_read_session` / `get_write_session` — sessions on the TEST engine, so
      the HTTP surface reads and writes the same database the other fixtures set up
      and clean. The write override commits, exactly as `write_session` does, so a
      test can assert the row survived the request rather than only the response.
    * `get_settings` — a settings object whose `tracking_carrier_api_key` and
      `grpc_api_key` are the two literals above, so neither the carrier tests nor
      the internal-route tests read or need a real env file.

    Nothing has to be switched off to build this app: it serves HTTP and only HTTP
    (JE-108), so starting it binds no port of its own and cannot collide with a
    locally-running service.
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
            grpc_api_key=TEST_GRPC_API_KEY,
            tracking_carrier_api_key=TEST_CARRIER_API_KEY,
        )

    application = create_app()
    application.dependency_overrides[get_read_session] = override_read
    application.dependency_overrides[get_write_session] = override_write
    application.dependency_overrides[get_settings] = override_settings
    return application


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """A `TestClient` over the real app.

    Used as a context manager, deliberately: that is what runs the app's startup
    and shutdown, and what makes `BackgroundTasks` (which TestMode progression is
    dispatched through) actually execute. A bare `TestClient(app)` would skip both.
    """
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def carrier_key() -> str:
    """The EXTERNAL carrier key the test app is configured with.

    Exposed as a fixture so a suite guarding a route that takes the INTERNAL key
    can present the carrier's and assert it is refused, without importing the
    other trust domain's constant by hand at every call site.
    """
    return TEST_CARRIER_API_KEY


@pytest.fixture
def seeded_tracking(session: Session) -> Tracking:
    """One COMMITTED tracking owned by a user with two DISTINCT identities.

    Committed, not merely flushed: the request under test runs on its own session,
    so an uncommitted row would be invisible to it and every assertion would pass
    or fail for the wrong reason.

    `user_id` and `cognito_sub` are deliberately unlike each other — a `usr_` id
    and a Cognito sub — so a test scoping by the wrong one cannot accidentally
    match. It also carries a second history row, so a cascade assertion has more
    than the single transition creation always writes.
    """
    from src.features.tracking.domain.repository import TrackingRepository
    from src.features.tracking.domain.status import TrackingStatus
    from src.shared.audit.audit_actor import AuditActor

    repo = TrackingRepository(session)
    tracking = repo.create(
        order_id="ord_seeded000000000001",
        user_id="usr_seeded00000000000a",
        cognito_sub="33333333-3333-4333-8333-333333333333",
        actor=AuditActor.CREATE_TRACKING,
    )
    repo.update_status(
        tracking=tracking,
        status=TrackingStatus.PROCESSING,
        actor=AuditActor.CARRIER_STATUS_UPDATE,
    )
    session.commit()
    return tracking
