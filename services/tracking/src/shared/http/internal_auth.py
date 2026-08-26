"""Internal service-to-service key check for `DELETE /v1/trackings/by-user`.

The second inbound key check in this service. Its sibling, `carrier_auth.py`,
validates the EXTERNAL carrier key; this one validates `GRPC_API_KEY`, the INTERNAL
credential (ADR-0003) that Users, Orders and Tracking share. The two must never be
interchanged: accepting the carrier's key here would let an outside vendor erase a
user's delivery history.

Kept as its own module rather than folded into `carrier_auth` precisely because the
values differ — one file per trust domain makes the wrong-key mistake structurally
harder than a shared helper with a key argument would.
"""

from __future__ import annotations

import hmac
import logging
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from src.shared.config.settings import Settings, get_settings

logger = logging.getLogger(__name__)

#: Same header NAME as the carrier's, different VALUE and different route. The two
#: never meet on one request.
INTERNAL_API_KEY_HEADER = "x-api-key"

SettingsDep = Annotated[Settings, Depends(get_settings)]


def internal_key_matches(provided: str | None, expected: str) -> bool:
    """True when `provided` equals `expected`, compared in constant time.

    Returns False (never raises) for a missing key, so an absent header and a wrong
    one are indistinguishable to the caller.
    """
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def require_internal_key(
    request: Request,
    settings: SettingsDep,
    x_api_key: Annotated[str | None, Header(alias=INTERNAL_API_KEY_HEADER)] = None,
) -> None:
    """Reject the request unless it carries the internal service key."""
    if internal_key_matches(x_api_key, settings.grpc_api_key):
        return

    # A mass soft-delete surface is the widest blast radius this service has.
    # NEVER log the key — not a prefix, not its length.
    logger.warning(
        "internal_delete_by_user_failed",
        extra={
            "app_event": "internal_delete_by_user_failed",
            "reason": "invalid_api_key",
            "client": request.client.host if request.client else "unknown",
        },
    )
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="invalid api key",
    )


#: Reusable annotation for the internally-authenticated routes.
InternalAuth = Depends(require_internal_key)
