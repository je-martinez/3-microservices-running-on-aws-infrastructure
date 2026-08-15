"""Stamp the active OpenTelemetry span's ids onto every log record.

WHY THIS EXISTS
---------------
Logs and traces are shipped over two completely different paths in this repo:
stdout -> Docker's fluentd driver -> OpenObserve for logs, OTLP -> the collector
-> Jaeger for traces. Nothing joins them automatically. `trace_id` on the log
line is the ONLY thing that lets a dashboard answer "show me every line, in
every service, for the request that produced this slow span".

Measured before this existed: Tracking emitted 0 of 348 log lines with a
`trace_id`, while Users emitted 32/42 and Orders 53/64 — so a trace that crossed
into Tracking simply lost its logs at the boundary.

WHY A FILTER, AND WHY ON THE HANDLER
------------------------------------
Same reasoning as `LogContextFilter`, which this sits beside: a filter mutates
the record before any formatter sees it, and installing it on the single root
HANDLER (see config.py) means it also catches records from loggers we do not
own — uvicorn's access lines, SQLAlchemy's statements — which propagate to that
handler. A formatter change would work too, but it would make the formatter
depend on OTel; keeping it a pure renderer is the existing design and
`json_formatter`'s docstring says so.

THE TWO RULES THAT MATTER
-------------------------
1. **Lowercase hex, not the raw ints.** The OTel API models ids as Python ints;
   `format_trace_id` / `format_span_id` render them zero-padded to 32 and 16 hex
   chars respectively. Users and Orders emit that same hex form, and a JOIN is
   string equality — emitting `123456789` where another service emits
   `00000000000000000000000075bcd15` silently matches nothing.
2. **Omitted, never null, when there is no span.** Startup lines, the metrics
   publisher's ticks, and anything on a background task run outside a request
   and have no active span. `INVALID_SPAN` reports an all-zero context; writing
   `trace_id: "000...0"` would be worse than writing nothing, because it reads
   as a real id and 30 unrelated lines would appear to share a trace. This is
   the same rule the formatter already applies to `None` ([[logging-context]]).
"""

from __future__ import annotations

import logging

from opentelemetry import trace


class TraceContextFilter(logging.Filter):
    """Attach `trace_id` / `span_id` to each record when a span is active."""

    def filter(self, record: logging.LogRecord) -> bool:
        span_context = trace.get_current_span().get_span_context()

        # `is_valid` is False both when there is no span at all and when the
        # context is the all-zero INVALID_SPAN_CONTEXT — exactly the cases where
        # the fields must be absent rather than zeroed.
        if span_context.is_valid:
            # setattr only when absent, matching LogContextFilter's precedence
            # rule: an explicit `extra=` at the call site wins over ambient
            # enrichment.
            if not hasattr(record, "trace_id"):
                record.trace_id = trace.format_trace_id(span_context.trace_id)
            if not hasattr(record, "span_id"):
                record.span_id = trace.format_span_id(span_context.span_id)

        # Never filters anything out — this is enrichment, not selection.
        return True
