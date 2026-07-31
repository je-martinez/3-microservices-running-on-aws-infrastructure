"""Structured logging for the Tracking service.

`configure_logging()` is called once at application startup; `JsonFormatter`
renders each record and `LogContextFilter` merges in the per-request context
that `log_context` holds. See json_formatter.py for why this exists and
docs/shared/conventions/logging-context.md for the shared rules.
"""

from .config import configure_logging
from .context_filter import LogContextFilter
from .json_formatter import JsonFormatter
from .log_context import (
    get_log_context,
    merge_log_context,
    reset_log_context,
    set_log_context,
)

__all__ = [
    "configure_logging",
    "JsonFormatter",
    "LogContextFilter",
    "get_log_context",
    "merge_log_context",
    "reset_log_context",
    "set_log_context",
]
