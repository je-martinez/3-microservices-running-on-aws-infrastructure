"""`x-api-key` gRPC server interceptor (JE-90/JE-91).

Python counterpart of Users' `src/shared/grpc/api-key-interceptor.ts`, guarding
**every** RPC on this server: `CreateTracking` and both reads. Per
[[ADR-0003-grpc-inter-service]] the caller is a trusted internal service (Orders),
and this shared secret is what "trusted" means — the gRPC reads are unscoped, so a
caller past this gate can read any order's tracking.

## Constant-time comparison

The comparison uses `hmac.compare_digest`, never `==`. `==` on `str`/`bytes` short-
circuits at the first differing byte, so the time it takes leaks how long a shared
prefix the attacker guessed — enough to recover a key byte by byte given retries.
`compare_digest` takes the same time regardless. This mirrors Users' use of
`timingSafeEqual` for the same reason.

Note that a length mismatch is not hidden by any implementation (`compare_digest`
returns early for differing lengths, as does Node's `timingSafeEqual` guard) — the
key's *length* leaks, its *contents* do not. That is the same trade Users makes.

## Logging

A rejection is logged; the key — provided or expected — never is, per
[[logging-context]]. Not even a prefix or a length: this is a rotatable secret, and
a log line is exactly the low-trust sink it must not reach. The peer address is
logged instead, which is what is actually actionable.
"""

from __future__ import annotations

import hmac
import logging
from collections.abc import Callable

import grpc

logger = logging.getLogger(__name__)

#: Metadata key carrying the shared secret. gRPC lowercases metadata keys on the
#: wire, so this must be lowercase to match what a caller's `x-api-key` arrives as.
API_KEY_METADATA_KEY = "x-api-key"

_UNAUTHENTICATED_DETAILS = "invalid api key"


def api_key_matches(provided: str | None, expected: str) -> bool:
    """True when `provided` equals `expected`, compared in constant time.

    Returns False (never raises) for a missing key, so an absent header and a wrong
    one take the same path and are indistinguishable to the caller.
    """
    if provided is None:
        return False
    return hmac.compare_digest(provided.encode(), expected.encode())


def _extract_api_key(
    metadata: tuple[tuple[str, str | bytes], ...] | None,
) -> str | None:
    """Pull `x-api-key` out of inbound metadata, or None when absent.

    Metadata is a sequence of pairs, not a mapping, and a key may legitimately
    repeat. The FIRST occurrence wins — matching Users' `metadata.get(...)[0]`, so
    a caller sending a valid key plus a junk one is treated identically by both
    services rather than one accepting and the other rejecting.
    """
    if not metadata:
        return None
    for key, value in metadata:
        if key.lower() == API_KEY_METADATA_KEY:
            return value.decode() if isinstance(value, bytes) else value
    return None


class ApiKeyInterceptor(grpc.ServerInterceptor):
    """Rejects any RPC whose metadata lacks a matching `x-api-key`.

    Implemented by swapping in a handler that aborts, rather than by raising: an
    exception out of `intercept_service` surfaces as `UNKNOWN`, which would be
    indistinguishable from a handler crash. The RPC is denied with an explicit
    `UNAUTHENTICATED`, and the real handler is never reached — the request message
    is not even deserialized.
    """

    def __init__(self, expected_key: str) -> None:
        if not expected_key:
            # A blank expected key would make `compare_digest("", "")` true and
            # silently open every RPC. Settings already require a non-empty
            # GRPC_API_KEY; this is the second line of defense at the gate itself.
            raise ValueError("expected_key must not be empty")
        self._expected_key = expected_key
        self._deny = grpc.unary_unary_rpc_method_handler(self._abort)

    def _abort(self, request: object, context: grpc.ServicerContext) -> None:
        # Never log the provided or expected key — see the module docstring.
        logger.warning(
            "grpc_auth_failed",
            extra={
                "app_event": "grpc_auth_failed",
                "reason": "invalid_api_key",
                "peer": context.peer(),
            },
        )
        context.abort(grpc.StatusCode.UNAUTHENTICATED, _UNAUTHENTICATED_DETAILS)

    def intercept_service(
        self,
        continuation: Callable[
            [grpc.HandlerCallDetails], grpc.RpcMethodHandler | None
        ],
        handler_call_details: grpc.HandlerCallDetails,
    ) -> grpc.RpcMethodHandler | None:
        provided = _extract_api_key(handler_call_details.invocation_metadata)
        if api_key_matches(provided, self._expected_key):
            return continuation(handler_call_details)
        return self._deny
