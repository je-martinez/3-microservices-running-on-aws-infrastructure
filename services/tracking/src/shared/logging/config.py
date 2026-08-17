"""Install the JSON formatter on the root logger and on uvicorn's own loggers.

UVICORN IS THE PART THAT NEEDS CARE
-----------------------------------
uvicorn installs its own handlers on `uvicorn`, `uvicorn.error` and
`uvicorn.access` at startup, and those loggers have `propagate = False`. So
configuring only the root logger leaves uvicorn's access lines going out as
plain text while application lines go out as JSON — a mixed stream, which is
worse than either format alone because a downstream parser cannot rely on
anything.

The fix is to take the handlers off those three loggers and let them propagate
to the root, where our single JSON handler renders everything. Doing it in
`configure_logging()` (called at app startup, after uvicorn has set itself up)
rather than via uvicorn's `log_config` keeps this working under `uvicorn
src.main:app` on the command line, which is how the container runs it and
which never reads a log_config we would pass programmatically.

`uvicorn.access` is left ENABLED but reformatted. Its lines carry method, path
and status — genuinely useful — and the request path for this service contains
no PII: identifiers travel in headers and bodies, never in the URL. The one
route with an identifier in the path is /v1/trackings/{orderId}, and an order
id is already a first-class log field.
"""

from __future__ import annotations

import logging
import sys

from .context_filter import LogContextFilter
from .json_formatter import JsonFormatter
from .trace_filter import TraceContextFilter

# uvicorn attaches its own handlers to these and sets propagate = False.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

# SQLAlchemy does the same when echo=True (Settings.echo_sql, on outside
# production): it installs a handler on `sqlalchemy.engine` with a plain-text
# formatter of its own, so every statement went out TWICE — once as JSON through
# our pipeline, and once as raw text like
#   2026-08-02 00:49:37,970 INFO sqlalchemy.engine.Engine SELECT tracking.id, ...
# The raw copy has no service_name and no shared context, and a multi-line
# statement arrives as several unrelated records ("FROM tracking" on its own).
# It was 4187 of 12498 records in a 30-minute window — a third of the stream,
# unfilterable by service.
#
# Stripped the same way uvicorn's are: same fix, same reason, and the JSON copy
# already carries the statement with full context.
_SQLALCHEMY_LOGGERS = ("sqlalchemy", "sqlalchemy.engine", "sqlalchemy.pool")


def configure_logging(
    *,
    service_name: str = "tracking",
    deployment_environment: str = "local",
    level: int = logging.INFO,
) -> None:
    """Point every logger at one stdout handler rendering JSON.

    Idempotent: re-running replaces the handler rather than stacking a second
    one, so a test (or a reload) cannot end up emitting every line twice.
    """
    formatter = JsonFormatter(
        service_name=service_name,
        deployment_environment=deployment_environment,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    # Enrichment lives on the HANDLER, not on individual loggers: a filter on a
    # logger only sees records logged through that logger, while one on the
    # single root handler sees everything that reaches it — including uvicorn's
    # records, which the propagation fix below routes here.
    handler.addFilter(LogContextFilter())
    # Same placement, same reason: on the HANDLER, so uvicorn's and SQLAlchemy's
    # records (routed here by the propagation fix below) are correlated too — a
    # slow statement is only useful if it names the trace it belongs to. Adds
    # `trace_id`/`span_id` when a span is active and NOTHING when one is not.
    handler.addFilter(TraceContextFilter())

    root = logging.getLogger()
    # Remove existing handlers rather than adding to them — see the idempotency
    # note above.
    for existing in root.handlers[:]:
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)

    # Strip uvicorn's own handlers and let it propagate to root, so its access
    # lines are rendered by the same formatter as everything else.
    for name in _UVICORN_LOGGERS + _SQLALCHEMY_LOGGERS:
        library_logger = logging.getLogger(name)
        for existing in library_logger.handlers[:]:
            library_logger.removeHandler(existing)
        library_logger.propagate = True
