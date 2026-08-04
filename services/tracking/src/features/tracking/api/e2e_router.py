"""`DELETE /v1/trackings/e2e-cleanup` — the E2E teardown route (JE-111).

Mounted **only** when `E2E_TESTING_ENABLED` is set; see `src/main.py`. The peers
are Orders' `E2eEndpoints.cs` (mapped under the same flag in its `Program.cs`) and
Users' `routes.ts` (inside `if (env.E2E_TESTING_ENABLED)`), and the three now
spell the same route the same way.

## Its own router, like the other three

Same reason `init_tracking_router` and `carrier_router` are separate: this shares
the `/v1/trackings` prefix with them and nothing else. Keeping it apart means it
cannot acquire the carrier key dependency by proximity, and — more to the point —
the flag guard stays a property of *this whole router*, so a second E2E-only route
added here is gated by construction rather than by remembering to gate it.

## No caller identity — and that is the point

This route deliberately declares **no** `x-user-id` dependency. The harness's
teardown runs once, globally, at the end of a suite: there is no user session to
run it as, so any route requiring a caller would answer `401` to its only real
caller. An earlier version of this endpoint did exactly that.

What it deletes is therefore not "the caller's rows" but "the rows the harness
made" — those tagged `"E2E Source"` at creation, by a request that both sent
`x-e2e-source: true` and reached a service with `E2E_TESTING_ENABLED` on (see
`shared/http/e2e_source.py`). Every row a real user created is untagged and cannot
be touched here.

## Why it is `DELETE` on a literal path under `/v1/trackings`

`/v1/trackings/e2e-cleanup` sits where `trackings_router`'s `/{order_id}` path
parameter also matches. They do not collide today (`DELETE` vs `GET`), but
Starlette matches in declaration order and `main.py` registers this router first —
the same habit `init-tracking` follows for the same reason.

## Status codes

| Outcome | Code | Why |
|---|---|---|
| Cleaned up | 200 | With `{"deleted": N}` — see below |
| Flag off | 405 | The route does not exist at all — not a 403 on one that does |

`200` with a body rather than the `204` this endpoint used to return. The count is
what makes a teardown diagnosable: "the suite still sees its fixtures" and "the
cleanup matched nothing" are the same symptom from the client's side, and a `204`
leaves the harness unable to tell them apart without reading this service's logs.
Users' cleanup returns its count for the same reason.

`200` even when nothing matched. "No tagged trackings remain" is the state the
caller asked for, and it is true whether this call stamped ten rows or zero, so a
teardown re-run is not a failure — it reports `{"deleted": 0}`.

The `405` (rather than `404`) with the flag off is a consequence of the path
layout, not a guard: `/v1/trackings/e2e-cleanup` still matches
`trackings_router`'s `GET /v1/trackings/{order_id}` as a *path*, so with no
`DELETE` registered Starlette reports the method as not allowed. Equivalent for a
caller — nothing serves `DELETE` here — and preferable to registering a route
purely so it can answer `404`.

## The handler is `def`, not `async def`

pymysql blocks; a `def` handler runs in FastAPI's threadpool. With the identity
dependency gone this route has no `async def` dependency left at all, so the whole
request now runs off the event loop.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter

from src.features.tracking.api.schemas import E2eCleanupResponse
from src.features.tracking.commands.e2e_cleanup import e2e_cleanup
from src.shared.http.dependencies import WriteSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["e2e"])


@router.delete(
    "/e2e-cleanup",
    summary=(
        "[E2E] Soft-delete every tracking tagged 'E2E Source' "
        "(only mounted when E2E_TESTING_ENABLED)"
    ),
    responses={
        200: {"description": "The tagged trackings are soft-deleted"},
    },
)
def cleanup(session: WriteSession) -> E2eCleanupResponse:
    """Soft-delete every live tracking tagged as an E2E fixture.

    The **write** session, not the read one: this mutates. Its generator
    dependency owns the commit, so the stamps land during teardown after this
    returns — a raise here leaves nothing behind.

    No `cognito_sub` on the log line: there is no caller identity on this request,
    and the convention omits unknown fields rather than emitting null.
    """
    deleted = e2e_cleanup(session)

    logger.info(
        "e2e_cleanup_succeeded",
        extra={
            "app_event": "e2e_cleanup_succeeded",
            "deleted_count": deleted,
        },
    )
    return E2eCleanupResponse(deleted=deleted)
