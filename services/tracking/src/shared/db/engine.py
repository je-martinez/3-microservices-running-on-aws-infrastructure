"""Read/write engine split, per ADR-0006.

Two engines, two sessionmakers: commands go to the **writer**, queries to the
**reader**. Locally both URLs resolve to the same Floci MySQL (Floci emulates no
Aurora read replica), but the split lives in code so local and prod behave the
same and a query can never silently land on the writer in production.

The driver is sync `pymysql` — pure Python, no build toolchain in the slim image.
FastAPI handlers that use these sessions must therefore be plain `def` (run in the
threadpool), not `async def`, so a blocking DBAPI call never stalls the event loop.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.shared.config.settings import Settings, get_settings


def _build_engine(url: str, *, echo: bool) -> Engine:
    return create_engine(
        url,
        echo=echo,
        # Floci's MySQL proxy drops idle connections; recycling below the server's
        # timeout and pre-pinging keeps a pooled connection from being handed out
        # dead ("MySQL server has gone away") on the first query after an idle gap.
        pool_pre_ping=True,
        pool_recycle=1800,
        pool_size=5,
        max_overflow=5,
        future=True,
    )


@lru_cache(maxsize=1)
def _engines(writer_url: str, reader_url: str, echo: bool) -> tuple[Engine, Engine]:
    """Build both engines once, keyed on the values rather than on `Settings`.

    The cache key is the three PRIMITIVES, not the settings object. Pydantic's
    `BaseSettings` is unhashable (`model_config` does not enable frozen), so
    `lru_cache` on a `Settings` parameter raises `TypeError: unhashable type:
    'Settings'` on the very first call — meaning no engine could be built at all
    and every real request would 500.

    That was invisible to the test suite, and structurally so: every suite binds
    its sessions to the fixture's own test engine, so nothing in the repo had ever
    called this function. It surfaced the first time the REST surface ran against
    the real settings singleton. Keying on primitives keeps the intended
    behaviour — one pair of engines per process — with a key `lru_cache` can
    actually hash.
    """
    return (
        _build_engine(writer_url, echo=echo),
        _build_engine(reader_url, echo=echo),
    )


def _current_engines() -> tuple[Engine, Engine]:
    settings: Settings = get_settings()
    return _engines(
        settings.database_writer_url,
        settings.database_reader_url,
        settings.echo_sql,
    )


def writer_engine() -> Engine:
    """Engine for all mutations (gRPC CreateTracking, the REST status update)."""
    return _current_engines()[0]


def reader_engine() -> Engine:
    """Engine for all reads (gRPC and REST alike)."""
    return _current_engines()[1]


def writer_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=writer_engine(), expire_on_commit=False, future=True)


def reader_sessionmaker() -> sessionmaker[Session]:
    return sessionmaker(bind=reader_engine(), expire_on_commit=False, future=True)


@contextmanager
def write_session() -> Iterator[Session]:
    """A transactional session on the WRITER.

    Commits on success, rolls back on error.
    """
    session = writer_sessionmaker()()
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
    """A read-only session on the READER. Never commits."""
    session = reader_sessionmaker()()
    try:
        yield session
    finally:
        session.close()
