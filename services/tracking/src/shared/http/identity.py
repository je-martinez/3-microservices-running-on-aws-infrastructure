"""Caller identity for the two user-scoped REST reads (JE-93).

The identity arrives as the gateway-injected `x-user-id` header — the same
mechanism Orders uses (`services/orders/src/Orders.Api/Middleware/
CallerContextMiddleware.cs`). Locally it is put there by nginx+njs, which decodes
the Cognito JWT and copies the `sub` claim onto every proxied request; in
production the equivalent mapping happens at the gateway. Either way the service
never parses a JWT itself — by the time a request reaches a handler, the header is
either present and trustworthy, or absent.

## The header is named `x-user-id` but holds a Cognito SUB

This is the single most misleading name on this surface, so the dependency below
is called `require_caller_sub` and returns a value every caller must treat as a
Cognito `sub`. nginx sets it literally as `proxy_set_header x-user-id $jwt_sub`
(`infra/modules/compute/nginx/nginx.conf`) — it is the JWT's `sub` claim, NOT the
internal `usr_` id that `tracking.user_id` holds. The two are different strings
for the same person, and a read scoped by the wrong one silently matches nothing.
Orders makes the same distinction, persisting both and filtering by `cognito_sub`.

## Why a dependency rather than middleware

Orders enforces this in middleware plus a `PublicRoutes` allowlist, because ASP.NET
middleware sees every request and has to be told which routes are exempt. FastAPI
gives the opposite default: a dependency applies to exactly the routes that declare
it, so `/v1/health` and the carrier PUT are unauthenticated by simply not asking for
it. That matters here more than in Orders — the carrier PUT must NOT depend on
`x-user-id` at all (see the design's "No JWT, no x-user-id" warning), and an
allowlist that has to remember to exempt it is one edit away from breaking it.

## Empty is missing

nginx sets `x-user-id` to the empty string when the token is missing or malformed
(see [[nginx-njs-x-user-id-injection]]) rather than omitting the header, so an
empty value must be treated exactly like an absent one. Accepting `""` would scope
a read to `cognito_sub = ''`, which matches no row — a silent empty result instead
of the `401` the caller deserves.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

#: The gateway-injected header carrying the caller's identity.
USER_ID_HEADER = "x-user-id"


def require_caller_sub(
    x_user_id: Annotated[str | None, Header(alias=USER_ID_HEADER)] = None,
) -> str:
    """Return the caller's **Cognito sub**, or `401` when the gateway injected none.

    The return value is the JWT `sub` claim despite the header's name — see the
    module docstring. Never pass it where an internal `usr_` id is expected.

    `401`, not `403`: the request carries no usable credential at all, so this is
    a failure to authenticate, not a permission denial on an identified caller.
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing x-user-id",
        )
    return x_user_id


#: Reusable annotation for handlers scoped to the calling user. Named `CallerSub`,
#: not `CallerId`, so a handler cannot read it as "the user id" and scope a query
#: by `Tracking.user_id` — the mismatch that 404s every user-scoped read.
CallerSub = Annotated[str, Depends(require_caller_sub)]
