"""The `x-test-mode` request header (JE-105).

TestMode is a request-shaped fact, so when creation moved from gRPC to REST the
flag had to move with it. It travels as a **header**, `x-test-mode: true`, and not
as a field on the request body.

## Why a header and not a body field

The design already specifies this exact header, one hop upstream: `x-test-mode: true`
on `POST /v1/orders`, guarded by `E2E_TESTING_ENABLED`, which Orders reads and
propagates as the `test_mode` field on `CreateTracking`
(`docs/domains/tracking/specs/tracking-service-design.md` — "End-to-end origin: a
client header on Orders, not an Orders-side decision"). Now that a client can reach
Tracking's creation directly, the same spelling reaching the same flag means one
name for one concept across the two services, and an E2E test sets the identical
header whichever endpoint it drives.

The shape also matches what the flag IS. `order_id` and `shipping_address` describe
the shipment; `test_mode` describes **how this one request was made** — the same
distinction `CreateTrackingResult.test_mode` already documents as the reason the
flag is not a column. Metadata about a request belongs beside the request's other
metadata (`x-user-id`, `x-api-key`, `traceparent`) rather than inside the resource
representation, where a reader would reasonably expect every field to end up
persisted.

There is a practical consequence too: a body field would put a test-harness switch
in the endpoint's public schema and in its OpenAPI document, where every real client
sees it. As a header it stays out of the resource contract entirely.

## Only the exact string `"true"`

Point 2 of the design's list: "only the exact string value `"true"` activates it.
Absent, empty, or any other value means false." Case-insensitively here, because a
header value is not a wire enum and `True` from a hand-written curl should not
silently mean false — but nothing beyond that: no `1`, no `yes`. A flag that
switches on for several spellings is one a caller enables by accident.

## No `E2E_TESTING_ENABLED` guard in THIS service

Orders guards its header with that flag. This dependency deliberately does not, and
the reason is that the guard is not implemented here to be dropped — Tracking has
never had the setting, and adding one is a change to the generated env files
([[env-files]]) and therefore to `infra/**`, outside this task. Recording it rather
than silently doing nothing: the flag remains an open item for whoever closes the
REST migration. Until then TestMode is reachable wherever this endpoint is, exactly
as it already is through `CreateTracking`, which has no such guard either.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header

#: The header carrying the TestMode request flag.
TEST_MODE_HEADER = "x-test-mode"

#: The ONE value that activates TestMode (compared case-insensitively).
TEST_MODE_ACTIVE_VALUE = "true"


def parse_test_mode(
    x_test_mode: Annotated[str | None, Header(alias=TEST_MODE_HEADER)] = None,
) -> bool:
    """Whether this request asked for automatic TestMode progression.

    Never raises: an unrecognized value is `False`, not a `400`. A caller who
    misspells the flag gets an ordinary tracking, which is the same outcome as not
    sending it at all — failing the creation of a real shipment over a malformed
    test-harness header would be the worse trade by a wide margin.
    """
    if x_test_mode is None:
        return False
    return x_test_mode.strip().lower() == TEST_MODE_ACTIVE_VALUE


#: Reusable annotation for handlers that honor the flag.
TestMode = Annotated[bool, Depends(parse_test_mode)]
