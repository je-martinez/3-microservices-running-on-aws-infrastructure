"""Structured logging for the Tracking service.

`configure_logging()` is called once at application startup; `JsonFormatter`
renders each record, `LogContextFilter` merges in the per-request context that
`log_context` holds, and `TraceContextFilter` stamps the active OpenTelemetry
span's `trace_id`/`span_id` so a line can be joined to its trace in Jaeger. See
json_formatter.py for why this exists and
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
from .trace_filter import TraceContextFilter

__all__ = [
    "configure_logging",
    "JsonFormatter",
    "LogContextFilter",
    "TraceContextFilter",
    "get_log_context",
    "merge_log_context",
    "reset_log_context",
    "set_log_context",
]
