"""Seed the per-request log context from the inbound request.

Runs as pure ASGI middleware rather than a `BaseHTTPMiddleware` subclass on
purpose: BaseHTTPMiddleware runs the downstream app in a separate anyio task,
and `contextvars` set there are NOT visible to the caller — which would make
`merge_log_context` from inside a handler invisible to anything logging
outside it. Plain ASGI middleware stays in the same task, so a merge part-way
through a request reaches every later line.

Only the sub is available this early: it arrives as the `x-user-id` header the
gateway injects (nginx `proxy_set_header x-user-id $jwt_sub`). The internal
`usr_` id is NOT resolvable here — it takes a gRPC call to Users, and this
middleware runs for every route including `/v1/health` and the carrier PUT,
neither of which has a user identity to resolve or any business making that
call. It is added a moment later by `stamp_caller_user_id`
(`shared/http/log_identity.py`), a dependency that the user-scoped routes declare
and those two do not — so the exemption is structural rather than an allowlist
this middleware would have to remember to keep correct.

The header is NOT trusted for authorization here — this is logging only.
Authorization stays with `require_caller_sub` (shared/http/identity.py), which
is where an absent or empty sub must be rejected. Seeding a context field
never grants access to anything.

This middleware ALSO publishes the `http_errors_total` counter, because it is
the only place in this service that sees the final status of every response —
including a 404 produced by Starlette's router, which no handler and no
dependency ever runs for. Only 4xx/5xx are counted; a metric per 2xx would be a
request-rate metric the request log already provides.

For the same reason it emits the per-request `request completed` log line: this
is the one layer that observes the final status and the wall time of EVERY
request, and the field names are a cross-service schema (Users emits the
identical five keys from its Fastify `onResponse` hook), so one dashboard query
covers all three services. Without it Tracking published no `http_route` and no
`duration_ms` at all, leaving its dashboard unable to show request rate,
latency or top routes.
"""

from __future__ import annotations

import asyncio
import logging
import time

from src.shared.config.settings import metrics_enabled
from src.shared.logging.log_context import reset_log_context, set_log_context
from src.shared.metrics.cloudwatch_metrics import (
    SERVICE_DIMENSION,
    MetricsPublisher,
    shared_metrics_publisher,
)

logger = logging.getLogger(__name__)

# The header the gateway injects, carrying the JWT's `sub` — never the usr_ id.
USER_ID_HEADER = b"x-user-id"

#: The counter published for every 4xx/5xx response.
HTTP_ERRORS_METRIC = "http_errors_total"

#: The liveness probe's route. Served UNPREFIXED (the gateway publishes it as
#: /v1/tracking/health and nginx rewrites), so this is the path FastAPI matches.
#: Only its 2xx responses are exempt from the request log — see _log_request.
HEALTH_ROUTE = "/v1/health"


class LogContextMiddleware:
    """ASGI middleware seeding the log context for each HTTP request."""

    def __init__(self, app, metrics: MetricsPublisher | None = None) -> None:
        self.app = app
        # Injected by tests so they record instead of reaching for the
        # `lru_cache`d boto3 client (which would leak across the whole run).
        # Left None in production and resolved lazily per error response, so
        # constructing the app never builds an AWS client.
        self._metrics = metrics

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        cognito_sub = None
        for name, value in scope.get("headers", []):
            if name.lower() == USER_ID_HEADER:
                cognito_sub = value.decode("latin-1")
                break

        # `http.response.start` is the ONLY message carrying the status, so the
        # status has to be captured off the wire here — there is no response
        # object at this layer to read it from afterwards.
        status_holder: dict[str, int] = {}

        async def send_wrapper(message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
            await send(message)

        # Set even when the sub is absent (health checks, the carrier PUT):
        # a fresh empty context per request is what stops one request's
        # identity leaking into the next through a reused context.
        token = set_log_context(cognito_sub=cognito_sub)
        started = time.perf_counter()
        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            # `Exception`, not `BaseException`: a cancellation (the client hung
            # up mid-request) produces no response at all, so counting it as a
            # server error would inflate the 5xx series with disconnects.
            #
            # An unhandled exception IS a 500, and it is the one case this
            # middleware cannot read off the wire: Starlette's
            # ServerErrorMiddleware sits OUTSIDE every `add_middleware` layer, so
            # it builds that 500 response after the exception has already passed
            # through here — `send_wrapper` never sees an `http.response.start`.
            # Counting it here is what keeps the 5xx series from missing exactly
            # the failures it exists to count. Re-raised immediately: the error
            # response is still ServerErrorMiddleware's to produce.
            #
            # The request log is emitted here too, for the same reason: a handler
            # that raised is the request most worth having a line for, and the
            # `else` branch below never runs for it.
            self._log_request(scope, 500, started)
            await self._publish_http_error(500)
            raise
        else:
            status = status_holder.get("status")
            self._log_request(scope, status, started)
            if status is not None and status >= 400:
                await self._publish_http_error(status)
        finally:
            # Reset LAST, so a publish failure's own log line still carries the
            # request's identity.
            reset_log_context(token)

    def _log_request(self, scope, status: int | None, started: float) -> None:  # noqa: ANN001 - ASGI scope
        """Emit the one `request completed` line for this request. Never raises.

        INFO for every request including 4xx/5xx: the status code carries the
        outcome, so raising the severity would double-encode it and make an error
        rate computed from `severity_text` disagree with one computed from
        `http_response_status_code`. Users emits these at INFO for the same
        reason.

        HEALTH CHECKS ARE THE ONE EXCEPTION, and only while they SUCCEED. An
        earlier version of this docstring argued against any exemption: a probe
        that starts failing is worth seeing, and an exemption list is one more
        thing to keep correct. Both halves still hold, and neither requires
        logging the successes — so the rule keeps the first and drops the second.

        What forced it was the ratio, measured rather than assumed: 353 of this
        service's 368 log lines in an hour were `GET /v1/health -> 200`, 96% of
        the stream, against 2 lines describing actual tracking work. The liveness
        probe runs forever at a fixed interval, so that share only grows on an
        idle system — it is volume that scales with uptime instead of with usage,
        which is the definition of noise.

        A SUCCEEDING probe is also the one request whose log line carries no
        information: the container being up already says it, and its duration is
        a constant. A FAILING one carries the status and the latency that explain
        why, so it is logged like any other request.

        Scoped by status rather than by a route list, which is what keeps the
        original objection answered: there is no list to maintain, and the rule
        reads as "successful probes are not events" rather than as "this path is
        special".

        Wrapped like `_publish_http_error` below: the response has already been
        sent (or, on the 500 path, the original exception is about to be
        re-raised), so an observation of it must never become the request's
        failure — nor replace the exception the application actually raised.
        """
        try:
            # `scope["route"]` is set by FastAPI's `APIRoute.matches`, and it is
            # the matched TEMPLATE (`/v1/trackings/{order_id}`) rather than the
            # concrete URL. Logging the raw path instead would make every order id
            # its own "route" and blow up dashboard cardinality — the field would
            # stop being groupable, which is the only reason it exists.
            #
            # It is absent whenever nothing matched (a 404 from the router), so the
            # raw path is the fallback: those requests still deserve a line, and the
            # cardinality risk is bounded by the fact that they hit no route at all.
            route = scope.get("route")
            http_route = getattr(route, "path", None) or scope.get("path", "")
            duration_ms = (time.perf_counter() - started) * 1000

            # The health-check exemption — successes only. See the docstring.
            # `status is not None` matters: a request that produced no response
            # status at all (the 500 path re-raising before http.response.start)
            # is NOT a success and must still be logged.
            if (
                http_route == HEALTH_ROUTE
                and status is not None
                and 200 <= status < 300
            ):
                return

            logger.info(
                "request completed",
                extra={
                    "http_request_method": scope.get("method", ""),
                    "http_route": http_route,
                    "http_response_status_code": status,
                    "duration_ms": duration_ms,
                },
            )
        except Exception:  # noqa: BLE001 - swallowed on purpose, see docstring
            logger.exception(
                "request_log_failed",
                extra={
                    "app_event": "request_log_failed",
                    "reason": "log_raised",
                },
            )

    async def _publish_http_error(self, status: int) -> None:
        """Count one 4xx/5xx. Never raises — the response has already been sent.

        An INJECTED publisher is used unconditionally (that is a test saying
        exactly what it wants). Only the fallback to the process-wide one is
        gated on `METRICS_ENABLED` and guarded: resolving it goes through
        `get_settings()`, which raises `ValidationError` on an incomplete
        environment — the same reason the lifespan reads the flag straight from
        `os.environ` rather than through the model. Turning a 404 into a 500
        because a metric could not be built would be exactly the failure mode the
        publisher's own log-and-swallow policy exists to prevent.
        """
        publisher = self._metrics
        if publisher is None:
            if not metrics_enabled():
                return
            try:
                publisher = shared_metrics_publisher()
            except Exception:  # noqa: BLE001 - swallowed on purpose, see docstring
                logger.exception(
                    "metric_publish_failed",
                    extra={
                        "app_event": "metric_publish_failed",
                        "reason": "publisher_unavailable",
                        "metric_name": HTTP_ERRORS_METRIC,
                    },
                )
                return

        try:
            # boto3 is blocking: publishing inline would stall the event loop (and
            # therefore every other in-flight request) for a full HTTP round trip.
            await asyncio.to_thread(
                publisher.publish,
                HTTP_ERRORS_METRIC,
                1,
                {
                    "Service": SERVICE_DIMENSION,
                    "StatusClass": "5xx" if status >= 500 else "4xx",
                },
            )
        except Exception:  # noqa: BLE001 - swallowed on purpose, see docstring
            # `CloudWatchMetricsPublisher.publish` already swallows its own
            # failures, so this only fires for an injected publisher that does
            # not. It matters on the 500 path, where raising here would REPLACE
            # the application's original exception with a metrics error.
            logger.exception(
                "metric_publish_failed",
                extra={
                    "app_event": "metric_publish_failed",
                    "reason": "publish_raised",
                    "metric_name": HTTP_ERRORS_METRIC,
                },
            )
