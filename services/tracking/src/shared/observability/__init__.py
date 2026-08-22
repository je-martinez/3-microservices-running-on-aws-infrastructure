"""Manual OpenTelemetry instrumentation for the Tracking service.

Everything auto-instrumentation cannot know about lives here: the FastAPI,
SQLAlchemy, gRPC and SQS spans come from `opentelemetry-instrument` (see
requirements-runtime.txt), but a *business flow* is not a library call and no
instrumentation can find it — hence `workflow_span`.
"""

from .workflow_tracing import mark_phase, workflow_span

__all__ = ["mark_phase", "workflow_span"]
