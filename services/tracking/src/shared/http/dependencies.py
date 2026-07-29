"""Database-session dependencies for the REST handlers.

Thin adapters over `shared/db/engine.py`'s two context managers, so the read/write
split from ADR-0006 reaches the HTTP surface the same way it reaches the gRPC one:
the reads take a **reader** session, the carrier PUT takes a **writer** session
which owns the transaction (status update + history row commit together).

Injected as FastAPI dependencies rather than opened inside the handlers so tests
can override them with sessions bound to the test engine — the same seam
`TrackingServicer(writer=…, reader=…)` gives the gRPC surface.

Both are plain generator dependencies (`def`, not `async def`): pymysql is a
blocking driver, so FastAPI must run these in the threadpool. An `async def`
dependency (or handler) here would stall the event loop on every query — see the
note in `shared/db/engine.py`.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Annotated

from fastapi import Depends
from sqlalchemy.orm import Session

from src.shared.db.engine import read_session, write_session


def get_read_session() -> Iterator[Session]:
    """A reader session for the two user-scoped reads. Never commits."""
    with read_session() as session:
        yield session


def get_write_session() -> Iterator[Session]:
    """A writer session for the carrier status update.

    Commits on success and rolls back on error, because `write_session` does — so
    a handler that raises after mutating leaves nothing behind.
    """
    with write_session() as session:
        yield session


ReadSession = Annotated[Session, Depends(get_read_session)]
WriteSession = Annotated[Session, Depends(get_write_session)]
