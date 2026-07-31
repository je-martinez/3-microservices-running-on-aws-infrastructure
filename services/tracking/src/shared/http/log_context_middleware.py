"""Seed the per-request log context from the inbound request.

Runs as pure ASGI middleware rather than a `BaseHTTPMiddleware` subclass on
purpose: BaseHTTPMiddleware runs the downstream app in a separate anyio task,
and `contextvars` set there are NOT visible to the caller — which would make
`merge_log_context` from inside a handler invisible to anything logging
outside it. Plain ASGI middleware stays in the same task, so a merge part-way
through a request reaches every later line.

Only the sub is available this early: it arrives as the `x-user-id` header the
gateway injects (nginx `proxy_set_header x-user-id $jwt_sub`). The internal
`usr_` id is resolved later, over gRPC to Users, and handlers add it with
`merge_log_context(user_id=...)` at that point.

The header is NOT trusted for authorization here — this is logging only.
Authorization stays with `require_caller_sub` (shared/http/identity.py), which
is where an absent or empty sub must be rejected. Seeding a context field
never grants access to anything.
"""

from __future__ import annotations

from src.shared.logging.log_context import reset_log_context, set_log_context

# The header the gateway injects, carrying the JWT's `sub` — never the usr_ id.
USER_ID_HEADER = b"x-user-id"


class LogContextMiddleware:
    """ASGI middleware seeding the log context for each HTTP request."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        cognito_sub = None
        for name, value in scope.get("headers", []):
            if name.lower() == USER_ID_HEADER:
                cognito_sub = value.decode("latin-1")
                break

        # Set even when the sub is absent (health checks, the carrier PUT):
        # a fresh empty context per request is what stops one request's
        # identity leaking into the next through a reused context.
        token = set_log_context(cognito_sub=cognito_sub)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_log_context(token)
