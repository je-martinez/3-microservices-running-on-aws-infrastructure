"""One manual span per business workflow.

The three Tracking flows in
docs/superpowers/specs/2026-08-18-distributed-tracing-spans-design.md Decision 3:
`init_tracking`, `carrier_status_update`, `test_mode_progression`.

WHY THIS EXISTS
---------------
Auto-instrumentation can only see what a library does: an HTTP request, a SQL
statement, an outbound gRPC call. It cannot see that four of those together are
"a tracking was created", which is the unit a person actually asks about. Without
a workflow span, a trace shows the FastAPI span and its children with no name for
what the request was doing, and the `*_failed` reason lives only in the logs.

Mirrors the SAME shape as Users' `withWorkflowSpan` and Orders' `IWorkflowTracer`,
deliberately: the three services produce spans a single Jaeger query can read the
same way.

THE THREE RULES
---------------
1. **The span always closes, including on the exception path.** Here that is free:
   `start_as_current_span` is itself a context manager, so Python's own `finally`
   ends the span whether the block returned or raised. An unclosed span is not an
   error anywhere — it silently never reaches Jaeger, and the flow disappears from
   the cascade while the code still looks instrumented.
2. **The attributes are the flow log's fields.** `app_event`, `order_id`,
   `tracking_id`, and `reason` on failure — the same tokens the `*_started` /
   `*_succeeded` / `*_failed` lines already carry ([[logging-context]]), so trace
   and logs tell one story and neither needs the other to be understood. Callers
   set the late ones (`tracking_id`, `reason`) on the yielded span at exactly the
   point they log them.
3. **The exception is re-raised untouched.** The routers turn domain errors into
   HTTP status codes; swallowing or wrapping one here would turn a 409 into a 500
   without any handler changing.

A plain `@contextmanager`, not `@asynccontextmanager`: it wraps `with` blocks in
both sync handlers (the carrier PUT) and async ones (`init_tracking`,
`run_progression`), and a sync context manager works in both. It does NOT
introduce a suspension point of its own, which is what keeps it usable around an
`await`.

`start_as_current_span` attaches the span to the CURRENT context, which is what
`TraceContextFilter` reads to stamp `trace_id` on every log line inside the block
— and what a child span (SQLAlchemy's, the SQS client's) parents itself to.
Because OTel's context is a `contextvars.ContextVar`, that attachment follows the
same rule the log context does (see `logging/log_context.py`): a task COPIES the
context at creation time and its changes do not flow back. So the `with` must live
INSIDE the coroutine that does the work, never around the `create_task` that
spawns it.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

_tracer = trace.get_tracer("tracking-workflow")


@contextmanager
def workflow_span(name: str, **attributes: str | int | float | bool) -> Iterator[Span]:
    """Run a workflow inside an INTERNAL span named after the flow.

    Yields the span so the body can attach what it only learns later — the
    `tracking_id` it just wrote, or the `reason` a failure branch logs.
    """
    # `record_exception=False, set_status_on_exception=False` are load-bearing,
    # not defensive noise. Both DEFAULT to True, and the SDK applies them in its
    # own `__exit__` — which runs AFTER the except arm below. Leaving the defaults
    # on produces a span with the `exception` event recorded TWICE (once here,
    # once by the SDK) and a status description of "ValueError: <msg>" rather than
    # the message this code chose, because a span's status can only leave UNSET
    # once and the SDK's write lands first. Verified, not theoretical.
    with _tracer.start_as_current_span(
        name,
        kind=SpanKind.INTERNAL,
        attributes=attributes,
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except Exception as exc:
            span.record_exception(exc)
            # The message is the exception's own text; the machine-readable
            # `reason` is a separate attribute the caller sets, matching its log.
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            raise
        else:
            span.set_status(Status(StatusCode.OK))
