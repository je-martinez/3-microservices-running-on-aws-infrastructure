"""Structured logging for the Tracking service.

`configure_logging()` is called once at application startup; `JsonFormatter`
is the renderer it installs. See json_formatter.py for why this exists and
docs/shared/conventions/logging-context.md for the shared rules.
"""

from .config import configure_logging
from .json_formatter import JsonFormatter

__all__ = ["configure_logging", "JsonFormatter"]
