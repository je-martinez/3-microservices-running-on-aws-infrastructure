"""The read/write engine factory (ADR-0006).

These build engines but never CONNECT — SQLAlchemy's `create_engine` is lazy, so a
DSN pointing at nothing is fine here. That is deliberate: the point is the wiring,
not the database, and the wiring is precisely what every other suite bypasses.

## Why this file exists at all

`shared/db/engine.py` was structurally untested: every suite binds its sessions to
the fixture's own test engine, so nothing in the repo had ever called
`writer_engine()`. It was carrying a bug that made it raise on the FIRST call —
`_engines` was `@lru_cache`'d on a `Settings` parameter, and Pydantic's
`BaseSettings` is unhashable, so `TypeError: unhashable type: 'Settings'` came back
instead of an engine. No engine could be built, and every real request would have
500'd, while 245 tests passed.

It surfaced the first time the REST surface was exercised against the real settings
singleton rather than an override. So: a test that actually calls the production
factory, so the next such bug fails here instead of in a container.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import Engine

from src.shared.config.settings import get_settings
from src.shared.db import engine as engine_module

WRITER_URL = "mysql+pymysql://test:test@writer.invalid:3306/tracking"
READER_URL = "mysql+pymysql://test:test@reader.invalid:3306/tracking"


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Point the settings singleton at these URLs, and reset both caches.

    Both caches: `get_settings` and `_engines` are each `lru_cache`d for the life
    of the process, so leaving either populated would leak this test's engines into
    every later test — and, worse, let this test pass on a cached value it never
    actually produced.
    """
    monkeypatch.setenv("DATABASE_WRITER_URL", WRITER_URL)
    monkeypatch.setenv("DATABASE_READER_URL", READER_URL)
    monkeypatch.setenv("GRPC_API_KEY", "internal-key")
    monkeypatch.setenv("TRACKING_CARRIER_API_KEY", "external-carrier-key")
    monkeypatch.setenv("ENVIRONMENT", "test")

    get_settings.cache_clear()
    engine_module._engines.cache_clear()
    yield
    get_settings.cache_clear()
    engine_module._engines.cache_clear()


class TestEngineFactory:
    def test_writer_engine_can_actually_be_built(self) -> None:
        """The regression. This raised `TypeError: unhashable type: 'Settings'`."""
        assert isinstance(engine_module.writer_engine(), Engine)

    def test_reader_engine_can_actually_be_built(self) -> None:
        assert isinstance(engine_module.reader_engine(), Engine)

    def test_the_two_engines_use_their_own_urls(self) -> None:
        """The read/write split must survive to the DSN, or every query silently
        lands on the writer in production.

        Compared on the HOST, not `str(url)` — SQLAlchemy masks the password in a
        URL's string form (`test:***@…`), which is the right default and would make
        a full-string comparison assert against a redaction.
        """
        assert engine_module.writer_engine().url.host == "writer.invalid"
        assert engine_module.reader_engine().url.host == "reader.invalid"

    def test_they_are_different_engines(self) -> None:
        assert engine_module.writer_engine() is not engine_module.reader_engine()

    def test_engines_are_built_once_per_process(self) -> None:
        """One pooled engine pair per process — rebuilding on every call would
        leak connection pools until the container ran out of file descriptors."""
        assert engine_module.writer_engine() is engine_module.writer_engine()
        assert engine_module.reader_engine() is engine_module.reader_engine()

    def test_sessionmakers_bind_to_their_respective_engines(self) -> None:
        assert (
            engine_module.writer_sessionmaker().kw["bind"]
            is engine_module.writer_engine()
        )
        assert (
            engine_module.reader_sessionmaker().kw["bind"]
            is engine_module.reader_engine()
        )
