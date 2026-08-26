"""Per-request log context, merged into every record by the logging filter.

The Python counterpart of Users' `shared/logging/log-context.ts`, which uses
AsyncLocalStorage for the same job. `contextvars` is the direct analogue: it is
task-local, so concurrent requests on the same event loop never see each
other's values, and a value set before an `await` is still there afterwards.

WHY THIS EXISTS
---------------
Without it every call site has to repeat the identity by hand:

    logger.info("...", extra={"order_id": ..., "user_id": ..., ...})

which is forgettable (a handler that omits a field produces a line nobody
notices is impoverished) and unavailable in depth — a repository or the
TestMode progression has no request identity in scope, so those lines went out
with no context at all. Setting it once per request and having the filter merge
it means a flow log and a request log carry the same fields regardless of where
they were emitted, with no logger threaded through constructors.

EVERY FIELD IS OPTIONAL AND OMITTED WHEN UNKNOWN. An emitted `user_id: null`
is worse than an absent key: it reads as a resolved value that happened to be
null, rather than "not known at this point in the request" — see
docs/shared/conventions/logging-context.md.

> [!warning] Set the context and await INSIDE the same task
> This repo has already been bitten by the equivalent trap in Users: Prisma's
> promises are lazy, so an `await` outside the AsyncLocalStorage callback ran
> with the context already gone ([[prisma-lazy-promise-breaks-als]]).
> `contextvars` has a matching subtlety — a value set inside a task is NOT
> visible to the caller after the task ends, and `asyncio.create_task` COPIES
> the context at creation time, so a task spawned before a `merge` never sees
> that merge. TestMode progression spawns exactly such a task; it therefore
> stamps its own context rather than inheriting one it may not have.
"""

from __future__ import annotations

import contextvars
from typing import Any

# The keys this context may carry. Deliberately a fixed set rather than a free
# dict: the shared context is a convention (same field names across all three
# services, so one dashboard query spans them), not a scratchpad. A typo'd key
# would otherwise silently become a new indexed field.
_ALLOWED_KEYS = frozenset(
    {
        "cognito_sub",  # raw Cognito sub, from the x-user-id header
        "user_id",      # internal usr_ id, once identity has been resolved
        "order_id",
        "tracking_id",
        "email_hash",   # non-reversible email id — never a plaintext email
        # The cross-service correlation id (`req_<nanoid>`), seeded at ingress
        # by LogContextMiddleware and forwarded on every outbound hop. Unlike
        # the identity fields above it is ALWAYS present inside a request:
        # `resolve_request_id` either honours the caller's or mints one.
        "request_id",
        # `hit` | `miss` | `bypass` for a cached route. OMITTED, never null, on a
        # route that is not cached and on every route when `CACHE_ENABLED=false`
        # — `_clean` below drops a None, so a caller merging `cache_result=None`
        # costs nothing and adds no field.
        "cache_result",
    }
)

_log_context: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "tracking_log_context"
)


def get_log_context() -> dict[str, Any]:
    """The active context, or an empty dict outside a request."""
    return _log_context.get({})


def set_log_context(**fields: Any) -> contextvars.Token:
    """Replace the context for the current task. Returns a reset token.

    Callers that need to restore the previous value (a background task
    stamping its own identity, say) keep the token and pass it to
    `reset_log_context`.
    """
    return _log_context.set(_clean(fields))


def merge_log_context(**fields: Any) -> None:
    """Add fields to the ACTIVE context, part-way through a request.

    The point of this is late-resolved identity: Tracking learns the internal
    `usr_` id only after calling Users over gRPC, and every line after that
    should carry it. Replaces the dict rather than mutating it in place —
    a ContextVar holding a mutated dict would leak the change to any context
    that copied the same reference (notably tasks spawned earlier).
    """
    cleaned = _clean(fields)
    if not cleaned:
        return
    _log_context.set({**_log_context.get({}), **cleaned})


def reset_log_context(token: contextvars.Token) -> None:
    """Restore the context a `set_log_context` call replaced."""
    _log_context.reset(token)


def _clean(fields: dict[str, Any]) -> dict[str, Any]:
    """Keep known keys with a real value; drop everything else.

    `None` and `""` are both dropped: an empty sub is exactly the case
    `identity.py` warns about, where a falsy value would otherwise be recorded
    as if it were an identity.
    """
    return {
        key: value
        for key, value in fields.items()
        if key in _ALLOWED_KEYS and value is not None and value != ""
    }
