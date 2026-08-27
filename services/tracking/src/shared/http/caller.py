"""Request-scoped caller context (JE-101).

The Python analogue of Orders' `ICurrentCaller`/`CurrentCaller`
(`services/orders/src/Orders.Api/Identity/`), and it copies that design's central
decision rather than reinventing one:

    reading the caller's SUB is free; resolving the internal `usr_` id is a
    NETWORK CALL, so it is explicit, awaited, and never hidden behind a property.

## Why the sub must stay network-free

`cognito_sub` is a plain attribute holding the value the gateway injected — no
lookup, no I/O, no failure mode. `resolved_internal_user_id` is likewise a plain
read that returns the id **only if resolution has already happened this request**,
and returns `None` otherwise instead of triggering it.

That "otherwise" is the whole point, and Orders wrote down why: a log enricher
reads the caller on every single event, and an attribute that fired a gRPC call
would turn logging into a network dependency — one hung Users making every log
line block. This service has no Serilog-style enricher yet, but the same trap
applies to anything that samples identity opportunistically (a middleware stamping
request context, a trace attribute, an error report). The safe shape is the one
where *nothing* can accidentally cause a call; only `resolve_internal_user_id()`
can, and its name says so.

## Two ways the memo gets filled, exactly one of which is a network call

`resolve_internal_user_id()` fills it by CALLING Users.
`seed_resolved_internal_user_id()` fills it from a value someone else already
has — specifically the identity cache's Redis hit, which answers the same
question without the RPC. The invariant above is unchanged by the second: it is
an explicit method, not a property, and it makes no call at all. Both exist
because the property is the ONLY thing the read handlers consult, so a value
obtained by any means has to land in the same place for the response cache to be
able to build a key.

## Why cached per request

The write path may need the `usr_` id more than once (persist it, then log it,
then include it in a response). Resolution is memoized on the instance — including
a `None` result, so a caller whose sub Users does not know does not re-ask on every
attempt. The instance lives exactly one request, so the cache cannot outlive the
identity it describes.

## Why a dependency and not middleware

Same reasoning as `identity.py`: a FastAPI dependency applies to precisely the
routes that declare it, so the unauthenticated routes (`/v1/health`, the carrier
PUT) simply never build a caller — instead of a middleware that runs everywhere
and needs an allowlist remembering to exempt them.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from src.shared.grpc.users_client import (
    ResolvedUser,
    UsersGrpcClient,
    shared_users_client,
)
from src.shared.http.identity import CallerSub


class UnknownUserError(Exception):
    """Users has no record for the caller's sub.

    Its own type rather than an `HTTPException`, so `CurrentCaller` stays a
    transport-agnostic piece the gRPC surface could reuse; the HTTP layer decides
    what status this becomes at the point it catches it (JE-105's endpoint), the
    same way Orders' `UnknownUserException` becomes a `404` in the endpoint and
    not in `CurrentCaller`.
    """

    def __init__(self, cognito_sub: str) -> None:
        # The sub is an opaque Cognito identifier, not PII in the sense email and
        # address are ([[logging-context]] carries `cognito_sub` on every log
        # line), so it is safe to name in the message.
        self.cognito_sub = cognito_sub
        super().__init__(f"no user for cognito sub {cognito_sub}")


class CurrentCaller:
    """Who is making this request, and — on demand — their internal id.

    One instance per request. Not thread-safe, and does not need to be: a request
    is handled by one thread, and the memoization below has no writer racing it.
    """

    def __init__(
        self, *, cognito_sub: str, users: UsersGrpcClient | None
    ) -> None:
        # `users` may be None: `log_identity.get_optional_users_client` hands one
        # over when no client could be built (a misconfigured environment), so
        # that enriching a log line degrades instead of failing a request that
        # never needed the `usr_` id. Nothing here dereferences it; only
        # `resolve_internal_user_id` does, and it is documented to raise.
        self._cognito_sub = cognito_sub
        self._users = users
        self._resolved: ResolvedUser | None = None
        self._has_resolved = False

    @property
    def cognito_sub(self) -> str:
        """The raw `x-user-id` value — the JWT `sub`. NO network call, ever."""
        return self._cognito_sub

    @property
    def resolved_internal_user_id(self) -> str | None:
        """The `usr_` id IF it was already resolved this request, else `None`.

        Deliberately does NOT trigger resolution — see the module docstring. A
        `None` here means "not looked up yet" *or* "looked up and unknown"; a
        reader that needs to tell those apart is on the write path and should call
        `resolve_internal_user_id()` instead.
        """
        return self._resolved.internal_id if self._resolved else None

    def seed_resolved_internal_user_id(self, internal_id: str) -> None:
        """Populate the resolution from a TRUSTED CACHED value. NO I/O.

        The identity cache (`shared/cache/identity_cache.py`) answers
        `cognito_sub -> user_id` from Redis without running its loader, and the
        loader is the ONLY thing that would otherwise set the memo below. Without
        this method a cache HIT left `_resolved` at `None`, so
        `resolved_internal_user_id` answered `None`, `CacheKeys` declined to build
        a key, and the response cache silently stopped caching anything for every
        request after the first — which is exactly what happened in production.

        Deliberately verbose in name, and deliberately NOT a setter on the
        property: this is the one supported way to fill the memo without a
        network call, and a reader of a call site should see that a value is
        being INJECTED rather than looked up. The module's central invariant is
        untouched — no property triggers resolution, and this method makes no
        call either.

        ## Only `internal_id` is known here

        The identity cache stores the `usr_` id and nothing else, on purpose:
        `email` and `full_name` are PII and are kept out of Redis
        ([[logging-context]]). So the `ResolvedUser` built here is PARTIAL, and
        the two absent fields take their "missing" spellings rather than a
        fabricated value — `email=None` ("Users has no address on file", the same
        value `UsersGrpcClient.resolve` normalizes `""` to) and `full_name=""`.

        That partiality is safe for the ONE consumer that can observe it. Only
        `resolved_internal_user_id` reads `_resolved` off a seeded caller, and it
        reads `internal_id` alone. The publisher that needs `email` and
        `full_name` sits on the WRITE path
        (`update_tracking_status` / the events publisher), which never builds a
        caller through `stamp_caller_user_id` — it takes the persisted row's
        identities and resolves the user through its own gRPC call. If that ever
        changes, a seeded caller must NOT be handed to it: an `email=None` there
        is indistinguishable from "Users holds no email" and would drop a
        notification rather than fail loudly.

        `_has_resolved` is set too, so a subsequent `resolve_internal_user_id()`
        returns the seeded id instead of making the call this seeding exists to
        avoid.

        Ignores a falsy `internal_id` rather than storing one: an empty string
        would make `resolved_internal_user_id` answer `""`, which `CacheKeys`
        treats as unkeyable anyway, while `_has_resolved` would suppress the real
        lookup. Doing nothing degrades to today's behaviour — no caching — which
        is the documented fail-open direction.
        """
        if not internal_id:
            return
        self._resolved = ResolvedUser(
            internal_id=internal_id,
            cognito_sub=self._cognito_sub,
            # NOT fabricated: see the docstring. These are the two fields the
            # identity cache does not carry, in their genuine "absent" spellings.
            email=None,
            full_name="",
        )
        self._has_resolved = True

    def resolve_internal_user_id(self) -> str:
        """Resolve the caller's internal `usr_` id, caching it for this request.

        The one method here that talks to the network. Raises `UnknownUserError`
        when Users has no such user — a `None` return would push the same decision
        onto every write-path caller, and a write that silently proceeded without
        a `user_id` is precisely the mis-attribution the two-identities rule in
        `services/tracking/CLAUDE.md` §5b exists to prevent.

        Synchronous, like every other DB/gRPC touch in this service: FastAPI runs
        the `def` handlers that call it in a threadpool.

        Raises `AttributeError` when built with no client at all — a case only
        `log_identity` creates, and only inside a block that swallows everything.
        Deliberately not a graceful `None`: on the write path a missing client is a
        misconfiguration that must be loud, not a user who happens to be unknown.
        """
        if not self._has_resolved:
            # Set BEFORE the assignment can be skipped: a NOT_FOUND caches as
            # `None`, so an unknown sub is asked about once per request rather
            # than once per call site.
            self._resolved = self._users.resolve(self._cognito_sub)
            self._has_resolved = True
        if self._resolved is None:
            raise UnknownUserError(self._cognito_sub)
        return self._resolved.internal_id


def get_users_client() -> UsersGrpcClient:
    """The process-wide Users client.

    A FastAPI dependency purely so tests can override it (`app.dependency_
    overrides[get_users_client]`) with a client pointed at an in-process stub
    server — the same seam `get_read_session`/`get_write_session` give the DB.

    The channel underneath is built once and reused for the life of the process
    (see `users_client.shared_users_client`): a channel is a connection pool, and
    per-request construction would pay a TCP + HTTP/2 handshake on every call.

    Resolved lazily, inside the function body, so merely importing this module
    neither opens a channel nor requires a valid environment — the routes that do
    not declare `Caller` (health, the carrier PUT) never reach this at all.
    """
    return shared_users_client()


def get_current_caller(
    cognito_sub: CallerSub,
    users: Annotated[UsersGrpcClient, Depends(get_users_client)],
) -> CurrentCaller:
    """Build the per-request caller context.

    Depends on `CallerSub`, so a route declaring this inherits its `401` when the
    gateway injected no `x-user-id` — the caller context can never exist without
    an identity to describe.
    """
    return CurrentCaller(cognito_sub=cognito_sub, users=users)


#: Reusable annotation for handlers that need the caller's identity. Named for the
#: caller, not the id, because the id is the part that costs a network call.
Caller = Annotated[CurrentCaller, Depends(get_current_caller)]
