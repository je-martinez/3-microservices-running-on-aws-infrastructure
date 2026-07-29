"""Carrier API-key authentication for `PUT /v1/trackings/{order_id}/status` (JE-94).

The caller here is a third-party carrier/webhook, not an end user. Its gateway
route is declared `auth = false`, so the request never passes a Cognito authorizer
and carries no `x-user-id`: **this service is the only thing standing in front of
an endpoint that mutates delivery state.**

## A different key from the internal one, deliberately

`TRACKING_CARRIER_API_KEY` is an EXTERNAL credential handed to a vendor;
`GRPC_API_KEY` is the INTERNAL service-to-service secret (ADR-0003), which this
service now only ever PRESENTS outbound when calling Users. Reusing one as the
other would give an outside party a credential that authenticates as an internal
service against every gRPC surface in the mesh. `settings.py` declares them as two
fields and the design's "Auth schemes" section spells out why.

## Constant-time comparison

`api_key_matches` uses `hmac.compare_digest`, never `==`. `==` on `str`/`bytes`
short-circuits at the first differing byte, so the time it takes leaks how long a
shared prefix the attacker guessed — enough to recover a key byte by byte given
retries. `compare_digest` takes the same time regardless. This mirrors Users'
`timingSafeEqual` for the same reason.

A length mismatch is not hidden by any implementation (`compare_digest` returns
early for differing lengths, as does Node's `timingSafeEqual` guard) — the key's
*length* leaks, its *contents* do not. That is the same trade Users makes.

It lives here, next to its single caller, rather than in a shared module: this is
the ONLY inbound key check left in the service. The gRPC server that used to share
it — and its `x-api-key` interceptor — were removed with the gRPC surface (JE-108),
so a shared home would now be a module with one importer pretending to have two.

## 401, not 403

A missing or wrong key is answered `401 Unauthorized`. `403` would mean "we know
who you are and you may not do this" — but a bad key identifies nobody, so there is
no principal to forbid. It also keeps the two failure modes indistinguishable: a
caller cannot tell a wrong key from an absent one, so the endpoint reveals nothing
about whether a key it was given is *nearly* right.
"""

from __future__ import annotations

import hmac
import logging
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from src.shared.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: Header carrying the carrier's key. Spelled `x-api-key` to match the repo's
#: existing key-header idiom (the internal service key travels under the same name
#: as gRPC metadata). Same NAME, different VALUE and different transport — the two
#: never meet on one request.
CARRIER_API_KEY_HEADER = "x-api-key"

#: Settings injected rather than imported, so a test can override the expected key
#: with `app.dependency_overrides[get_settings]` instead of mutating the process
#: environment and clearing an lru_cache.
SettingsDep = Annotated[Settings, Depends(get_settings)]


def api_key_matches(provided: str | None, expected: str) -> bool:
    """True when `provided` equals `expected`, compared in constant time.

    Returns False (never raises) for a missing key, so an absent header and a wrong
    one take the same path and are indistinguishable to the caller.
    """
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def require_carrier_key(
    request: Request,
    settings: SettingsDep,
    x_api_key: Annotated[str | None, Header(alias=CARRIER_API_KEY_HEADER)] = None,
) -> None:
    """Reject the request unless it carries the carrier key. Returns nothing.

    Deliberately returns `None`: unlike `require_caller_id`, this dependency yields
    no identity for the handler to use. The carrier is authenticated, never
    identified — which is precisely why the PUT handler scopes by `order_id` alone
    and must not reuse the reads' ownership filter.
    """
    if api_key_matches(x_api_key, settings.tracking_carrier_api_key):
        return

    # Log the attempt — an unauthenticated, state-mutating endpoint is the widest
    # attack surface this service has, and failed-attempt visibility is the
    # cheapest mitigation available (see the design's "Auth schemes").
    #
    # NEVER log the key, provided or expected — not even a prefix or its length.
    # Unknown fields are omitted, never null, per [[logging-context]].
    logger.warning(
        "carrier_status_update_failed",
        extra={
            "app_event": "carrier_status_update_failed",
            "reason": "invalid_api_key",
            "client": request.client.host if request.client else "unknown",
        },
    )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid api key",
    )


#: Reusable annotation for the carrier-authenticated endpoint.
CarrierAuth = Depends(require_carrier_key)
