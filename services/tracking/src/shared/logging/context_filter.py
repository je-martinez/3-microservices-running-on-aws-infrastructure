"""Merge the per-request log context into every record.

A `logging.Filter` rather than a Formatter change, because filters run on the
LOGGER (so they see every record, including uvicorn's, which our config routes
to the same root handler) and can mutate the record before any formatter sees
it. The formatter stays a pure renderer.

Precedence: an explicit `extra=` at the call site WINS over the ambient
context. The narrow, deliberate value should beat the ambient one — a handler
logging about a different order than the request's own is being specific on
purpose, and silently overwriting that with the request's order_id would make
the log lie.
"""

from __future__ import annotations

import logging

from .log_context import get_log_context


class LogContextFilter(logging.Filter):
    """Attach the active request context to each record."""

    def filter(self, record: logging.LogRecord) -> bool:
        for key, value in get_log_context().items():
            # setattr only when absent: an explicit extra= at the call site
            # takes precedence (see module docstring).
            if not hasattr(record, key):
                setattr(record, key, value)
        # Never filters anything out — this is enrichment, not selection.
        return True
