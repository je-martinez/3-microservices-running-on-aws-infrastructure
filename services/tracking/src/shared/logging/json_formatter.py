"""JSON log formatting for the Tracking service.

WHY THIS EXISTS
---------------
Tracking configured no logging at all: `logging.getLogger(__name__)` with no
formatter inherits uvicorn's plain-text default, so every line went out as

    INFO:     127.0.0.1:45966 - "GET /v1/health HTTP/1.1" 200 OK

That is unfilterable downstream. Logs reach OpenObserve through Docker's
fluentd driver (stdout -> the collector's fluent_forward receiver, NOT OTLP,
which carries traces only), so a line with no fields is a line no dashboard
query can select on.

Worse, the routers already pass the right data — `logger.info(...,
extra={"order_id": ..., "user_id": ...})` — and Python's default formatter
DISCARDS `extra` unless the format string names each key. The values were being
produced and thrown away. This formatter is what makes them queryable, which is
the whole point: filter by `user_id` or `order_id` in the dashboard and get
every line for that user or order, across services.

Field schema matches what Users emits (`shared/logging/logger.ts`), verified
against its live output, so a Tracking record and a Users record are the same
shape downstream: severity_text, severity_number, timestamp, service_name,
deployment_environment, message — plus whatever the call site passed in `extra`.

See docs/shared/conventions/logging-context.md for the shared context, the PII
rules, and why success is INFO + app_event=*_succeeded rather than a SUCCESS
severity (SUCCESS is not an OTel level).

No third-party dependency: the stdlib can do this, and a logging library in the
runtime image would be a dependency to pin, patch, and justify for no gain.
"""

from __future__ import annotations

import datetime as _datetime
import json
import logging
from typing import Any

# OTel severity numbers (logs data model). Kept explicit rather than derived
# from levelno so the mapping is auditable against the spec: DEBUG=5, INFO=9,
# WARN=13, ERROR=17, FATAL=21.
_SEVERITY_NUMBER = {
    logging.DEBUG: 5,
    logging.INFO: 9,
    logging.WARNING: 13,
    logging.ERROR: 17,
    logging.CRITICAL: 21,
}

# OTel severity NAMES, which are not Python's.
#
# `record.levelname` is what this used to emit directly, and for two levels it
# is wrong for our schema: Python says WARNING and CRITICAL where the OTel logs
# data model — and every other service here — says WARN and FATAL. Both spellings
# were reaching the backend at once (6 WARNING rows from this service beside 1
# WARN row from orders), so a dashboard filtering on either one silently returned
# half the matches. That is worse than no filter, because it looks like it worked.
#
# The collector normalizes WARNING -> WARN as well, as a safety net for any
# future source. This mapping is the actual fix: the wrong name never leaves the
# process. A level with no entry falls back to `levelname`, so a custom level
# still logs something meaningful rather than disappearing.
_SEVERITY_TEXT = {
    logging.DEBUG: "DEBUG",
    logging.INFO: "INFO",
    logging.WARNING: "WARN",
    logging.ERROR: "ERROR",
    logging.CRITICAL: "FATAL",
}

# LogRecord attributes that are Python's own bookkeeping, never log fields. Any
# attribute NOT in this set came from the call site's `extra` and is emitted.
# Listing what to exclude (rather than what to include) is what lets a new
# `extra` key reach the dashboard without touching this file.
_RESERVED = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename",
        "funcName", "levelname", "levelno", "lineno", "module", "msecs",
        "message", "msg", "name", "pathname", "process", "processName",
        "relativeCreated", "stack_info", "taskName", "thread", "threadName",
        # uvicorn puts an ANSI-coloured copy of its own message in `extra`. It
        # is a duplicate of `message` with escape codes in it — noise in a
        # dashboard, and it would be indexed as a distinct field.
        "color_message",
    }
)


class JsonFormatter(logging.Formatter):
    """Render each record as a single-line JSON object."""

    def __init__(self, *, service_name: str, deployment_environment: str) -> None:
        super().__init__()
        self._service_name = service_name
        self._deployment_environment = deployment_environment

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "severity_text": _SEVERITY_TEXT.get(record.levelno, record.levelname),
            "severity_number": _SEVERITY_NUMBER.get(record.levelno, 0),
            # UTC, ISO-8601 with milliseconds — the shape Users emits.
            "timestamp": _datetime.datetime.fromtimestamp(
                record.created, tz=_datetime.timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "service_name": self._service_name,
            "deployment_environment": self._deployment_environment,
            "message": record.getMessage(),
        }

        # Everything the call site passed via `extra`. Values that are not
        # JSON-serialisable are stringified rather than dropped: losing a field
        # silently is how a diagnostic disappears exactly when it is needed.
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            # Unknown fields are OMITTED, never emitted as null — an explicit
            # null reads as "resolved, and it was null" rather than "not known
            # at this point in the request" (logging-context convention).
            if value is None:
                continue
            try:
                json.dumps(value)
                payload[key] = value
            except (TypeError, ValueError):
                payload[key] = str(value)

        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            payload["stack"] = self.formatStack(record.stack_info)

        return json.dumps(payload, default=str)
