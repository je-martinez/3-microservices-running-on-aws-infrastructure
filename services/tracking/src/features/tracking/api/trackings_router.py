"""The user-scoped REST reads (JE-93).

    GET /v1/trackings/{order_id}        -> one tracking + its history
    GET /v1/trackings?order_ids=a,b,c   -> many, each with its history

Both are behind the gateway's Cognito JWT authorizer, and both take the caller's
identity from the gateway-injected `x-user-id` header (see `shared/http/identity`).

## Route order matters

`GET /v1/trackings` (the batch read) is declared BEFORE `GET /v1/trackings/{order_id}`.
Starlette matches routes in declaration order, and while these two do not actually
collide today, declaring the literal path first is the habit that keeps a future
literal route (`/v1/trackings/mine`, say) from being swallowed by the path
parameter.

## Ownership semantics — matching Orders exactly

* **Single read:** another user's tracking answers `404`, identical to one that does
  not exist. Never `403` — that would confirm a tracking exists for that order id
  and turn the endpoint into an oracle for other people's order ids. The filtering
  happens inside the SQL (see `queries/get_my_trackings.py`), so there is no moment
  at which a non-owned row exists in this process to be leaked by a later change.
* **Batch read:** non-owned and unknown ids are silently **omitted**, never an
  error and never a partial-failure entry.

## Handlers are `def`, not `async def`

pymysql is a blocking driver, so these run in the threadpool. An `async def`
handler doing a blocking DBAPI round trip would stall the whole event loop —
including the health check.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, status

from src.features.tracking.api.schemas import (
    TrackingListResponse,
    TrackingResponse,
)
from src.features.tracking.queries.get_my_trackings import (
    get_my_tracking_by_order_id,
    get_my_trackings_by_order_ids,
)
from src.shared.http.dependencies import ReadSession
from src.shared.http.identity import CallerId

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["trackings"])

#: Upper bound on a single batch read. Not arbitrary caution: `order_ids` lands in
#: a `WHERE order_id IN (...)`, and an unbounded list lets one request build an
#: arbitrarily large query. The value comfortably exceeds any real page of orders.
MAX_BATCH_ORDER_IDS = 100


def _parse_order_ids(raw: str) -> list[str]:
    """Split the CSV query parameter, dropping blanks and duplicates.

    `?order_ids=a,,b` and `?order_ids=a,b,a` are both a caller being sloppy rather
    than an error worth failing on — the endpoint's whole contract is "return the
    ones you own among these", which is well-defined for either. Order is preserved
    only incidentally; the response is ordered by the query, not by the request.
    """
    seen: dict[str, None] = {}
    for part in raw.split(","):
        cleaned = part.strip()
        if cleaned:
            seen[cleaned] = None
    return list(seen)


@router.get(
    "",
    status_code=status.HTTP_200_OK,
    summary="Read several of the caller's trackings by order id",
)
def get_trackings(
    caller_id: CallerId,
    session: ReadSession,
    order_ids: Annotated[
        str,
        Query(
            description=(
                "Comma-separated order ids, e.g. `ord_a,ord_b`. Ids the caller "
                "does not own are omitted from the response."
            ),
        ),
    ],
) -> TrackingListResponse:
    """Return the caller's trackings among `order_ids`, each with its history.

    Always `200`, even when nothing matches: "none of these are yours" is a
    complete answer to the question asked, not a failure. An empty list is the
    correct body, and it is deliberately indistinguishable from "none of these
    exist" — see the ownership rule in the module docstring.
    """
    parsed = _parse_order_ids(order_ids)
    if len(parsed) > MAX_BATCH_ORDER_IDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"at most {MAX_BATCH_ORDER_IDS} order_ids per request",
        )

    found = get_my_trackings_by_order_ids(
        session, order_ids=parsed, user_id=caller_id
    )
    return TrackingListResponse(
        trackings=[
            TrackingResponse.from_entity(item.tracking, item.history)
            for item in found
        ]
    )


@router.get(
    "/{order_id}",
    status_code=status.HTTP_200_OK,
    summary="Read one of the caller's trackings by order id",
)
def get_tracking(
    caller_id: CallerId,
    session: ReadSession,
    order_id: Annotated[str, Path(description="The order's id")],
) -> TrackingResponse:
    """Return one of the caller's trackings with its history, or `404`.

    The `404` covers both "no such tracking" and "belongs to another user" — the
    two are the same answer by design. The failure is logged with the machine-
    readable `reason` the logging convention requires; `order_id` and `user_id` are
    part of the shared context and are safe to log, unlike the shipping address,
    which this surface does not even carry.
    """
    found = get_my_tracking_by_order_id(
        session, order_id=order_id, user_id=caller_id
    )
    if found is None:
        logger.info(
            "get_tracking_failed",
            extra={
                "app_event": "get_tracking_failed",
                "reason": "not_found",
                "order_id": order_id,
                "user_id": caller_id,
            },
        )
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="tracking not found",
        )

    return TrackingResponse.from_entity(found.tracking, found.history)
