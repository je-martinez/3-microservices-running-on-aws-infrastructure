"""The user-scoped REST reads (JE-93).

    GET /v1/trackings/{order_id}        -> one tracking + its history
    GET /v1/trackings?order_ids=a,b,c   -> many, each with its history

Both are behind the gateway's Cognito JWT authorizer, and both take the caller's
identity from the gateway-injected `x-user-id` header (see `shared/http/identity`).

## The header holds a Cognito sub, NOT the internal `usr_` id

Despite its name, `x-user-id` carries the JWT's `sub` claim — nginx sets it with
`proxy_set_header x-user-id $jwt_sub`. That is why these handlers pass it as
`cognito_sub`, and why `Tracking` persists both identities: `tracking.user_id`
holds the internal `usr_` id Orders resolved through Users, which no end-user
request ever carries. Filtering these reads by `user_id` would compare a sub
against a `usr_` id, match nothing, and 404 every read — including the caller's
own tracking, while looking entirely correct. See `domain/models.py`.

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

## Why these reads declare `IdentifiedCaller` rather than `CallerSub`

The scoping still uses the sub and nothing else — that part is unchanged, and
`caller.cognito_sub` is the same header value `CallerSub` returned. What the
richer dependency adds is one outbound resolution of the internal `usr_` id into
the log context, so every line of a read carries `user_id` the way creation's
already did (`shared/http/log_identity.py` explains the cost and why it is paid
here rather than in middleware).

It is genuinely extra work on a path that had none: a read now makes a gRPC call
to Users it did not make before. It is bounded — one call per request, memoized on
the caller — and it cannot fail the read: an unresolvable id merges nothing and the
line simply goes out without `user_id`.

## The workflow spans on a read — what they add, and what they must not repeat

Both reads already appear in Jaeger without a line of code here: auto-instrumentation
emits the FastAPI SERVER span and a child per SQLAlchemy statement. So `list_trackings`
and `get_tracking` add exactly one thing — the **business name** of what the request
was doing, and the fields that name is worth searching by.

That is also the constraint. The HTTP span already carries the method, the route
template and the status code, so putting any of them on the workflow span would be
duplication that can only ever disagree with the transport's own view. What these
spans carry instead is what the transport cannot know: which order ids were asked
for, how many came back, and the `reason` when the single read answers `404` — the
same token that read's `*_failed` line logs (see `get_tracking`).

`cognito_sub` stays off both spans, exactly as it stays off the reads' success
logging: it is the ownership key, and the scoping it drives is already provable from
the row ids that came back ([[logging-context]]).

## Why neither read logs on its happy path

Both spans are deliberately quiet on success, and that is not an omission left to
fill in later. A read already produces one line — the middleware's `request
completed`, with the route template, the status and `duration_ms` — and a
`*_succeeded` line beside it would repeat all three and add only `found_count`, a
number the caller can see in its own response body. These are the two most
frequent authenticated calls this service serves; [[logging-context]] measured the
cost of ignoring that here specifically (353 of 368 lines in an hour were the
health check, against 2 describing real work), and a success line per read is how
that ratio gets worse.

What the two flows log instead is exactly their failure branches, where the
request line genuinely cannot say why: the single read's `404`
(`get_tracking_failed`, `reason=not_found`) and the batch read's over-cap `400`
(`list_trackings_failed`, `reason=too_many_order_ids`). Both set the same
`app_event`/`reason` on the span at the same point, so the trace and the log say
one thing. A `*_started` line is not emitted for the same reason: the span already
carries `app_event=*_started` from the moment it opens, and on a sub-millisecond
read the start line's only reader would be a person scrolling past it.
"""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Query, Response, status
from pydantic import BaseModel

from src.features.tracking.api.schemas import (
    TrackingListResponse,
    TrackingResponse,
)
from src.features.tracking.queries.get_my_trackings import (
    get_my_tracking_by_order_id,
    get_my_trackings_by_order_ids,
)
from src.shared.cache.keys import CacheKeys
from src.shared.http.cache_dependencies import CacheEnabledDep, CacheGatewayDep
from src.shared.http.dependencies import ReadSession
from src.shared.http.log_identity import IdentifiedCaller
from src.shared.observability import workflow_span

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/trackings", tags=["trackings"])

#: Upper bound on a single batch read. Not arbitrary caution: `order_ids` lands in
#: a `WHERE order_id IN (...)`, and an unbounded list lets one request build an
#: arbitrarily large query. The value comfortably exceeds any real page of orders.
MAX_BATCH_ORDER_IDS = 100

#: `reason` for the `400` a batch read over the cap is rejected with. Names the
#: rule rather than the number, so the token survives a change to the cap.
TOO_MANY_ORDER_IDS_REASON = "too_many_order_ids"

#: `reason` for the single read's `404`. The token the `get_tracking_failed` line
#: already logs — the span and the log are the same field seen from two systems.
NOT_FOUND_REASON = "not_found"

#: Both reads carry the same TTL: a tracking advances through the carrier
#: webhook, which invalidates explicitly, so the TTL is only the safety net
#: bounding how long a MISSED invalidation could serve stale data.
READ_TTL_SECONDS = 60


def _serve_cached(
    response: Response,
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
    key: str | None,
) -> dict | None:
    """Consult the cache and stamp the response headers. Returns the body, or None.

    Three outcomes, and the header is the only place they are distinguishable to
    a client:

    * `HIT`    — a body, plus `X-Cache-TTL`. The handler does not run.
    * `MISS`   — no body. The handler runs; `_store_cached` writes the result.
    * `BYPASS` — no body, and Redis was unreachable. Kept distinct from MISS so
      an outage does not read as a poor hit rate on the dashboard.

    `key is None` means the caller's `user_id` could not be resolved, so no key
    can be built (see `CacheKeys`). That is a MISS with no write — the read is
    served correctly and simply is not cached.

    With `CACHE_ENABLED=false` this returns None and stamps NOTHING: a disabled
    cache emits no header at all, which is what makes the load test's A/B run
    comparable — the control arm looks exactly like a service with no cache.

    ## The header is the ONLY thing set here — `cache_result` is NOT merged

    Setting the log field from this function would be the obvious thing, and it
    does not work. These handlers are plain `def`, so FastAPI runs them in its
    threadpool, and a threadpool worker holds a COPY of the request's context.
    `merge_log_context` REBINDS the ContextVar rather than mutating the dict, so
    a rebind performed on the worker's copy dies with that copy when the handler
    returns: the field is visible inside the handler and absent from the
    `request completed` line. A silent failure, with nothing anywhere reporting
    it — the same trap `log_identity.py` documents twice.

    `LogContextMiddleware._capture_cache_result` reads the header back off
    `http.response.start` instead, in the request's own task, and merges it
    there. See that function for the full reasoning.
    """
    if not cache_enabled:
        return None
    if key is None:
        response.headers["X-Cache"] = "MISS"
        return None

    entry = cache.get(key)
    if entry.bypassed:
        response.headers["X-Cache"] = "BYPASS"
        return None
    if entry.hit:
        response.headers["X-Cache"] = "HIT"
        if entry.ttl_remaining is not None:
            response.headers["X-Cache-TTL"] = str(entry.ttl_remaining)
        return entry.value
    response.headers["X-Cache"] = "MISS"
    return None


def _store_cached(
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
    key: str | None,
    index_key: str | None,
    body: BaseModel,
) -> None:
    """Write a successful response into the cache. Only ever called on a 200.

    Reached only after the handler returned normally, so a `404`, a `400` and a
    `401` — each of which raises — can never get here. That is deliberately
    structural rather than a status check: a status check is something a future
    branch can forget to update, while an exception simply never arrives.

    `body.model_dump(mode="json")` and not `.model_dump()`: the response carries
    `datetime` fields, and `mode="json"` is what renders them as the ISO strings
    `json.dumps` can serialize — without it the gateway's `json.dumps` raises
    `TypeError`, which it swallows, and the entry is silently never written.
    """
    if not cache_enabled or key is None:
        return
    cache.set(
        key,
        body.model_dump(mode="json"),
        READ_TTL_SECONDS,
        index_key=index_key,
    )


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
    # Declared because FastAPI infers only the success shape: the `400` is raised
    # in the handler and the `401` comes from `IdentifiedCaller`, so neither
    # appears in the generated `openapi.yaml` unless it is written here. There is
    # deliberately no `404` — a batch read of ids the caller does not own is a
    # `200` with a shorter list, never a failure.
    responses={
        400: {"description": f"More than {MAX_BATCH_ORDER_IDS} order_ids"},
        401: {"description": "Missing x-user-id (no caller identity)"},
    },
)
def get_trackings(
    caller: IdentifiedCaller,
    session: ReadSession,
    response: Response,
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
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

    # `resolved_internal_user_id`, the PROPERTY, not `resolve_internal_user_id()`:
    # the id has already been resolved and memoized by `stamp_caller_user_id`
    # before this handler ran, so the property IS the resolved value. Calling the
    # method instead would raise `UnknownUserError` on a caller Users cannot
    # resolve — turning a 200 this service serves fine today into a 500, which is
    # exactly the regression the "skip caching when unresolved" rule prevents.
    user_id = caller.resolved_internal_user_id
    key = CacheKeys.tracking_list(caller.cognito_sub, user_id, parsed)

    cached = _serve_cached(response, cache, cache_enabled, key)
    if cached is not None:
        # Validated back through the response model rather than returned raw: a
        # stored entry written by an older deployment could have a shape this
        # version no longer serves, and a validation error here is caught by the
        # gateway's own JSON guard on the next read. Returning the model also
        # means FastAPI serializes it exactly as it does a fresh one, so a HIT
        # and a MISS are byte-identical bodies.
        return TrackingListResponse.model_validate(cached)

    # Parsed BEFORE the span opens, so `requested_count` is the number of distinct
    # ids the read will actually run against rather than however many commas the
    # caller sent. That is the number the `found_count` below is comparable to; the
    # raw string is not, and it is also the only one of the two an unbounded caller
    # could make arbitrarily long.
    with workflow_span(
        "list_trackings",
        app_event="list_trackings_started",
        requested_count=len(parsed),
    ) as span:
        if len(parsed) > MAX_BATCH_ORDER_IDS:
            # The one branch of these two reads that logs on top of the request
            # line, and the only one that has something the request line cannot
            # say. A `400` here is not a caller typo — it is a client asking for
            # more than the endpoint is willing to build a `WHERE ... IN` from,
            # which is either a paging bug upstream or someone probing the cap.
            # `http_response_status_code=400` alone cannot tell that apart from a
            # missing `order_ids` (FastAPI's own `422`) or any other rejection,
            # because the rule that fired and the size that broke it exist only
            # here. Hence the machine-readable `reason` plus the count.
            span.set_attribute("app_event", "list_trackings_failed")
            span.set_attribute("reason", TOO_MANY_ORDER_IDS_REASON)
            logger.warning(
                "list_trackings_failed",
                extra={
                    "app_event": "list_trackings_failed",
                    "reason": TOO_MANY_ORDER_IDS_REASON,
                    "requested_count": len(parsed),
                    "max_order_ids": MAX_BATCH_ORDER_IDS,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"at most {MAX_BATCH_ORDER_IDS} order_ids per request",
            )

        found = get_my_trackings_by_order_ids(
            session, order_ids=parsed, cognito_sub=caller.cognito_sub
        )

        # The pair (`requested_count`, `found_count`) is the whole diagnostic value
        # of this span: they diverge exactly when ids were unknown or not owned,
        # which is the endpoint's silent-omission contract and therefore the one
        # thing a `200` body cannot tell an operator apart from "you asked for
        # fewer". No order ids as attributes — a batch of 100 would put an
        # unbounded, high-cardinality list on every span for no query anyone runs.
        span.set_attribute("app_event", "list_trackings_succeeded")
        span.set_attribute("found_count", len(found))

        result = TrackingListResponse(
            trackings=[
                TrackingResponse.from_entity(item.tracking, item.history)
                for item in found
            ]
        )

    # Written OUTSIDE the span, after it closes: the cache write is not part of
    # the business flow the span names, and a Redis round trip inside it would
    # inflate the duration a reader takes for "how long the read took".
    _store_cached(
        cache,
        cache_enabled,
        key,
        CacheKeys.user_index(caller.cognito_sub, user_id) if user_id else None,
        result,
    )
    return result


@router.get(
    "/{order_id}",
    status_code=status.HTTP_200_OK,
    summary="Read one of the caller's trackings by order id",
    # The `404` description states the conflation on purpose: a consumer reading
    # the spec must not infer existence from it, which is the whole point of
    # answering the two cases identically (see the handler's docstring).
    responses={
        401: {"description": "Missing x-user-id (no caller identity)"},
        404: {"description": "No such tracking, or it belongs to another user"},
    },
)
def get_tracking(
    caller: IdentifiedCaller,
    session: ReadSession,
    response: Response,
    cache: CacheGatewayDep,
    cache_enabled: CacheEnabledDep,
    order_id: Annotated[str, Path(description="The order's id")],
) -> TrackingResponse:
    """Return one of the caller's trackings with its history, or `404`.

    The `404` covers both "no such tracking" and "belongs to another user" — the
    two are the same answer by design. The failure is logged with the machine-
    readable `reason` the logging convention requires; `order_id` and
    `cognito_sub` are part of the shared context and are safe to log, unlike the
    shipping address, which this surface does not even carry.
    """
    # The property, never the method — see the note in `get_trackings`.
    user_id = caller.resolved_internal_user_id
    key = CacheKeys.tracking_order(caller.cognito_sub, user_id, order_id)

    cached = _serve_cached(response, cache, cache_enabled, key)
    if cached is not None:
        return TrackingResponse.model_validate(cached)

    with workflow_span(
        "get_tracking",
        app_event="get_tracking_started",
        order_id=order_id,
    ) as span:
        found = get_my_tracking_by_order_id(
            session, order_id=order_id, cognito_sub=caller.cognito_sub
        )
        if found is None:
            # Set beside the log call, with the SAME token the line carries. Note
            # what this span does NOT say: it cannot distinguish "no such tracking"
            # from "belongs to somebody else", because the handler cannot either —
            # the ownership filter is inside the SQL, so the two cases are one
            # answer here as well as on the wire.
            span.set_attribute("app_event", "get_tracking_failed")
            span.set_attribute("reason", NOT_FOUND_REASON)
            logger.info(
                "get_tracking_failed",
                extra={
                    "app_event": "get_tracking_failed",
                    "reason": NOT_FOUND_REASON,
                    "order_id": order_id,
                    "cognito_sub": caller.cognito_sub,
                },
            )
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="tracking not found",
            )

        # `tracking_id` is the one field the request could not have supplied, and
        # the one a trace is worth pivoting on — it joins this read to the creation
        # and to every carrier update of the same shipment.
        span.set_attribute("app_event", "get_tracking_succeeded")
        span.set_attribute("tracking_id", found.tracking.id)
        span.set_attribute("status", found.tracking.status)

        result = TrackingResponse.from_entity(found.tracking, found.history)

    # See `get_trackings`: written after the span closes, not inside it.
    _store_cached(
        cache,
        cache_enabled,
        key,
        CacheKeys.user_index(caller.cognito_sub, user_id) if user_id else None,
        result,
    )
    return result
