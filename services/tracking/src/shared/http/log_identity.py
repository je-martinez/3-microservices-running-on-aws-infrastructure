"""Stamp the caller's internal `usr_` id onto every log line of a request.

`LogContextMiddleware` seeds `cognito_sub` from the gateway-injected header, which
costs nothing — it is already on the request. `user_id` is not: it is a `usr_` id
that only Users knows, so putting it on every line means one outbound gRPC call per
authenticated request, on read paths that previously made none. That cost is
accepted deliberately: a dashboard query joining Tracking to Orders and Users joins
on `user_id`, and a service whose read lines carry only a sub cannot participate in
it.

## Why a dependency, and not the middleware

The middleware runs for EVERY route. Resolving there would mean calling Users before
knowing whether the route wants an identity at all — and two of this service's four
surfaces must never make that call:

* `GET /v1/health` is probed continuously by the ALB. Identity resolution there
  would turn a liveness check into a dependency on Users being up.
* `PUT /v1/trackings/{order_id}/status` is the carrier's, authenticated by its own
  API key and identified by `order_id` alone (`services/tracking/CLAUDE.md` §5a).
  It carries no `x-user-id` — and a middleware guarding on "the header is present"
  would still fire on a stray one, paying a call on a request that has no business
  making it.

A guard would work today and break the first time someone adds a route. A
dependency inverts the default: it applies to exactly the routes that declare it,
which is the same reason `identity.py` and `caller.py` are dependencies rather than
middleware plus an allowlist. Health and the carrier PUT are exempt by simply not
asking.

The alternative of resolving lazily inside `CurrentCaller` was rejected outright:
its module docstring makes "no property may cause a network call" the central
invariant, precisely so a log enricher sampling identity cannot make logging depend
on Users. Enrichment pulling the value is that trap; this pushes it once, up front.

## Why `async def`, when every other dependency here is a plain `def`

Because a sync dependency's context merge is DISCARDED. FastAPI runs `def`
dependencies in a threadpool, which gets a COPY of the request's context — so a
`merge_log_context` inside one vanishes on return, exactly like the `to_thread`
trap in `init_tracking_router` ([[2026-07-31-contextvars-lost-across-task-boundaries]]).
Verified, not assumed: a sync dependency setting a ContextVar leaves the handler
reading the unset default.

An `async def` dependency runs in the request's own task, so the merge here is
visible to the handler, to anything logging deeper in the stack, AND to uvicorn's
access line, which is emitted after the handler returns. The blocking gRPC call is
pushed to a worker thread with `asyncio.to_thread` and the resolved id comes back as
a RETURN VALUE, merged on this side of the boundary — never inside the thread.

## Failure is never fatal

Enriching a log line must not be able to fail a request. Users being down, slow, or
having no record for the sub all end the same way: nothing is merged, the line goes
out without `user_id`, and the request proceeds. The context omits unknown fields
rather than emitting null ([[logging-context]]), so an absent id reads correctly as
"not known", and `Caller` caches the negative answer so a handler resolving later in
the same request does not re-ask.

The one thing that is NOT swallowed is a failure on the write path: `init_tracking`
still calls `resolve_internal_user_id()` itself and still turns `UnknownUserError`
into its `404`. This dependency having quietly failed first costs that call nothing
— the negative result is cached, so the handler raises immediately off the cache
rather than making a second call.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Annotated

import grpc
from fastapi import Depends, Request

from src.shared.grpc.users_client import UsersGrpcClient
from src.shared.http.caller import (
    CurrentCaller,
    UnknownUserError,
    get_users_client,
)
from src.shared.http.identity import CallerSub
from src.shared.logging import merge_log_context

logger = logging.getLogger(__name__)


def get_optional_users_client(request: Request) -> UsersGrpcClient | None:
    """The Users client, or `None` when one cannot be built.

    Two requirements pull against each other here, and this is what satisfies both.

    **Construction failures must degrade, not `500`.** `get_users_client` reads
    `get_settings()`, which raises `ValidationError` on an incomplete environment —
    and a read scoped by `cognito_sub` needs no client at all, so failing it over
    one is the "enrichment became a point of failure" outcome this module exists to
    prevent. Not hypothetical: it broke 24 read tests, which build the app
    deliberately without the DB/Cognito variables. So the call is wrapped.

    **`app.dependency_overrides[get_users_client]` must keep working.** That
    override is the seam the whole suite uses to point resolution at an in-process
    stub Users server. It could not be honoured by declaring `get_users_client` as
    an ordinary sub-dependency, because FastAPI resolves a sub-dependency BEFORE
    entering this function — putting its failure upstream of the `try` and back at
    the `500` this is here to avoid. Nor by calling it directly by import, which
    silently ignores the override and talks to whatever the environment names.

    Consulting the override table explicitly is what does both: the app's own
    substitution is respected, and the call still happens inside the guard.

    `get_users_client` itself stays strict. The write path genuinely cannot proceed
    without a client, and `Caller` must keep surfacing a misconfiguration there.
    """
    build = request.app.dependency_overrides.get(get_users_client, get_users_client)
    try:
        return build()
    except Exception:  # noqa: BLE001 - see the docstring; enrichment never fails
        logger.debug("log_identity_client_unavailable", exc_info=True)
        return None


#: The client, or `None`. A dependency rather than a direct call so the resolution
#: happens per request, with the app's overrides in view.
OptionalUsersClient = Annotated[
    UsersGrpcClient | None, Depends(get_optional_users_client)
]


async def stamp_caller_user_id(
    cognito_sub: CallerSub, users: OptionalUsersClient
) -> CurrentCaller:
    """Build the caller, resolve their `usr_` id, and merge it into the log context.

    Returns a `CurrentCaller` whose resolution has already been attempted — either
    it succeeded and is memoized, or it failed and the failure is memoized — so a
    handler that needs the id pays no second call.

    ## Why this builds the caller instead of depending on `Caller`

    Because `Caller` is a `Depends` chain and FastAPI resolves the whole chain
    BEFORE entering this function — so a failure inside it lands upstream of any
    `try` written here. `get_users_client` reads `get_settings()`, which raises
    `ValidationError` on an incomplete environment, and that surfaced as a `500` on
    reads that need no identity at all: 24 read tests, which build the app
    deliberately without the DB/Cognito variables. Enrichment had become the point
    of failure this module exists to prevent.

    Building the caller here, from `CallerSub` (a header read: no I/O, no settings)
    and an OPTIONAL client, puts every failure mode — misconfiguration, an
    unbuildable channel, an RPC error, an unknown user — inside the same guarded
    block, degrading the same way.
    """
    caller = CurrentCaller(cognito_sub=cognito_sub, users=users)
    user_id = await asyncio.to_thread(_resolve_cached, caller)
    # Merged HERE, after the await, on the request's own context. A merge inside
    # `_resolve_quietly` would land on the thread's COPY and be discarded — the
    # trap this repo has already been bitten by twice.
    merge_log_context(user_id=user_id)
    return caller


def _resolve_cached(caller: CurrentCaller) -> str | None:
    """`_resolve_quietly`, with the identity cache in front of it.

    Runs on a worker thread, like the call it wraps: the Redis client is the
    blocking sync API and so is the gRPC client, so neither may touch the event
    loop.

    The cache is built here rather than injected as a dependency for one reason:
    this function already runs on the thread, and building a gateway is a
    dictionary lookup into an `lru_cache`, not a connection. Injecting it would
    mean a second `Depends` on a path whose whole point is to add as little as
    possible.

    Two things stay exactly as they were. `_resolve_quietly` is still what runs
    on a miss, so every failure it swallows is still swallowed. And the result is
    still MEMOIZED ON THE CALLER by `CurrentCaller`, so a handler that resolves
    later in the same request pays nothing either way — the identity cache
    removes the cost across REQUESTS, `CurrentCaller` removes it within one.

    The import is INSIDE the function on purpose. `log_identity` is imported by
    `trackings_router`, which is imported by `main.create_app`; a module-level
    import of `redis_client` would pull `redis` and `get_settings` into that
    chain, and `test_openapi_spec.py` builds the app with no environment at all.
    """
    from src.shared.cache.identity_cache import IdentityCache
    from src.shared.cache.redis_client import shared_cache_gateway

    try:
        cache = IdentityCache(gateway=shared_cache_gateway())
    except Exception:  # noqa: BLE001 - an unbuildable cache is not a failure
        # `shared_cache_gateway` reads `get_settings()`, which raises
        # `ValidationError` on an incomplete environment — the exact failure
        # `get_optional_users_client` above exists to absorb, and for the exact
        # same reason: 24 read tests build the app without those variables.
        logger.debug("identity_cache_unavailable", exc_info=True)
        return _resolve_quietly(caller)
    return cache.resolve(caller.cognito_sub, lambda: _resolve_quietly(caller))


def _resolve_quietly(caller: CurrentCaller) -> str | None:
    """Resolve the `usr_` id, or `None` for ANY reason it cannot be had.

    Runs on a worker thread (the gRPC client is the blocking sync API), and swallows
    on purpose. Nothing about enriching a log line is worth failing a request over,
    so the `except` is deliberately broad rather than a list of the failures that
    happened to be foreseen:

    * `UnknownUserError` — Users has no record for this sub.
    * `grpc.RpcError` — Users is down, slow, or refused the call.
    * anything else — no client at all (`users` is `None`, so resolution raises
      `AttributeError`), a bad target, anything unanticipated. A narrow `except`
      here is how this module failed the first time: the foreseen errors were caught
      and the unforeseen one still `500`'d the request.

    `Exception`, not `BaseException`: a `CancelledError` from the client
    disconnecting must keep propagating.

    Logged at DEBUG, not WARNING — on the read paths this is pure enrichment, and a
    warning per request during a Users blip would bury the real signal.
    """
    try:
        return caller.resolve_internal_user_id()
    except UnknownUserError:
        # Ordinary on a read: the caller authenticated, their user row is simply
        # absent. Cached by `CurrentCaller`, so a later resolve costs nothing.
        _log_unresolved("unknown_user", caller.cognito_sub)
    except grpc.RpcError as error:
        code = error.code() if isinstance(error, grpc.Call) else None
        _log_unresolved(
            "users_unavailable",
            caller.cognito_sub,
            grpc_status=code.name if code is not None else "unknown",
        )
    except Exception:  # noqa: BLE001 - enrichment must never fail a request
        # No client, an unbuildable channel, anything unforeseen. Logged with a
        # traceback because unlike the two above this is NOT expected in normal
        # operation and someone should be able to find it.
        logger.debug(
            "log_identity_unresolved",
            extra={"reason": "resolution_error", "cognito_sub": caller.cognito_sub},
            exc_info=True,
        )
    return None


def _log_unresolved(reason: str, cognito_sub: str, **fields: str) -> None:
    """Record why enrichment came up empty, without raising and without PII."""
    logger.debug(
        "log_identity_unresolved",
        extra={"reason": reason, "cognito_sub": cognito_sub, **fields},
    )


#: Reusable annotation for user-scoped routes that want `user_id` on every log line.
#: Declaring it both authenticates the route (through `CallerSub`, so a missing
#: `x-user-id` is still a `401`) and stamps the resolved id.
IdentifiedCaller = Annotated[CurrentCaller, Depends(stamp_caller_user_id)]
