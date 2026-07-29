"""User-scoped read queries behind the two REST reads (JE-93).

The counterpart of `get_tracking.py`, which serves gRPC. Same repository methods,
one difference: these pass the caller's **Cognito sub**, so the ownership predicate
goes **into the query**. A tracking belonging to someone else is filtered out by
MySQL and never exists in this process — which is what makes "not yours" and "not
there" genuinely the same answer rather than two answers a later refactor could
pull apart.

## The scope is `cognito_sub`, not `user_id`

The value the handler passes here is whatever the gateway put in `x-user-id`, and
that header carries the Cognito `sub` (`proxy_set_header x-user-id $jwt_sub`), not
the internal `usr_` id. `Tracking.user_id` holds the latter — Orders resolves it
via Users and sends it over gRPC. The two are different strings for the same
person, so scoping by `user_id` matches nothing and 404s every read, the caller's
own included. The parameter is named `cognito_sub` throughout this file so the
mismatch cannot be reintroduced by a plausible-looking rename.

`cognito_sub` is required here, not optional. `get_by_order_id(order_id)` with the
argument omitted is the *unscoped* call, and that is a one-character difference
from a scoped one — so these wrappers exist precisely so the REST handlers never
call the repository directly and can never omit it by accident.
"""

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy.orm import Session

from src.features.tracking.domain.repository import TrackingRepository
from src.features.tracking.queries.get_tracking import (
    TrackingWithHistory,
    with_history,
)


def get_my_tracking_by_order_id(
    session: Session, *, order_id: str, cognito_sub: str
) -> TrackingWithHistory | None:
    """One of the CALLER'S trackings, or None.

    None covers both "no such tracking" and "exists but belongs to another user" —
    indistinguishable on purpose. The handler renders it as `404`, never `403`:
    a `403` would confirm that some tracking exists for that `order_id`, turning
    the endpoint into an oracle for other people's order ids.
    """
    tracking = TrackingRepository(session).get_by_order_id(
        order_id, cognito_sub=cognito_sub
    )
    if tracking is None:
        return None
    return with_history(tracking)


def get_my_trackings_by_order_ids(
    session: Session, *, order_ids: Sequence[str], cognito_sub: str
) -> list[TrackingWithHistory]:
    """The caller's trackings among `order_ids`, each with its history.

    Ids that do not exist, or exist but belong to another user, are **omitted** —
    never an error, never a per-id failure entry. A caller passing ten ids and
    owning three gets exactly three back with no indication of what happened to the
    other seven, which is the batch equivalent of the single read's `404`.

    Two queries regardless of how many ids are asked for: one `WHERE order_id IN
    (...) AND cognito_sub = ?`, plus one `selectin` load for all the history rows.
    """
    trackings = TrackingRepository(session).get_by_order_ids(
        order_ids, cognito_sub=cognito_sub
    )
    return [with_history(tracking) for tracking in trackings]
