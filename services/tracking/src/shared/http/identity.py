"""Caller identity for the two user-scoped REST reads (JE-93).

The identity arrives as the gateway-injected `x-user-id` header — the same
mechanism Orders uses (`services/orders/src/Orders.Api/Middleware/
CallerContextMiddleware.cs`). Locally it is put there by nginx+njs, which decodes
the Cognito JWT and copies the `sub` claim onto every proxied request; in
production the equivalent mapping happens at the gateway. Either way the service
never parses a JWT itself — by the time a request reaches a handler, the header is
either present and trustworthy, or absent.

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
a read to `user_id = ''`, which matches no row — a silent empty result instead of
the `401` the caller deserves.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status

#: The gateway-injected header carrying the caller's identity.
USER_ID_HEADER = "x-user-id"


def require_caller_id(
    x_user_id: Annotated[str | None, Header(alias=USER_ID_HEADER)] = None,
) -> str:
    """Return the caller's id, or raise `401` when the gateway injected none.

    `401`, not `403`: the request carries no usable credential at all, so this is
    a failure to authenticate, not a permission denial on an identified caller.
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing x-user-id",
        )
    return x_user_id


#: Reusable annotation for handlers that are scoped to the calling user.
CallerId = Annotated[str, Depends(require_caller_id)]
