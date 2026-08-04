"""`DELETE /v1/trackings/e2e-cleanup` command handler (JE-111).

The E2E suite's teardown: soft-deletes the trackings the harness created, so a
rerun starts from a clean slate. The peer of Orders' `Endpoints/E2eEndpoints.cs`
and Users' `http/e2e-cleanup.ts`.

Transport-free like every other command here — it takes a session and returns a
count, so the router is a thin translation.

## Deleted by TAG, not by caller

It was scoped by the caller's `cognito_sub` first, and that could not work: the
teardown runs ONCE at the end of a suite, globally, with no user session and
therefore no `x-user-id` header — so the endpoint's only real caller would have
been refused `401` by the very dependency that made the scoping possible.

Tagging at creation moves the decision to the one moment an identity IS present
(`shared/http/e2e_source.py`), and leaves this a single unscoped predicate: delete
what the harness made. Users' cleanup already worked this way, on the same literal
tag value.

Losing the caller scope loses nothing, because the safety it provided moved rather
than disappeared:

* a row is tagged only when the request said so **and** `E2E_TESTING_ENABLED` is
  on, so an untrusted client cannot enlist its own rows;
* this route is mounted only under that same flag;
* every row a real user ever created is untagged, and therefore untouchable here.

## Soft-delete, never a hard delete

Deleting stamps `deleted_at`/`deleted_by` ([[soft-delete]]). A test-support
endpoint is exactly where a "just DELETE the rows, it is only test data" shortcut
looks reasonable, and it is the one place it must not be taken: this route runs
against the SAME schema and the same database user as production, which is
granted no `DELETE` privilege at all. The rows stay, invisible to every read.

## The actor is the harness, not the caller

`AuditActor.E2E_CLEANUP` rather than any identity off the request — there is no
longer an identity on the request at all, but the reasoning predates that: a row
removed by the test harness must stay distinguishable from one removed by a real
flow, which is precisely the distinction `deleted_by` exists to record. Both
Orders and Users make the same call.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from src.features.tracking.domain.models import E2E_SOURCE_TAG
from src.features.tracking.domain.repository import TrackingRepository
from src.shared.audit.audit_actor import AuditActor


def e2e_cleanup(session: Session, *, tag: str = E2E_SOURCE_TAG) -> int:
    """Soft-delete every live tracking carrying `tag`; return how many were stamped.

    The tag is a parameter with a default rather than a constant read inside, so
    the behaviour is stated at the boundary and a test can pin "only this tag" by
    seeding another one — but no caller has to know the literal.

    Does not commit — the caller's `write_session` owns the transaction boundary,
    exactly as `create_tracking` and `update_tracking_status` do.

    Idempotent: a second call stamps nothing (the rows are no longer live) and
    returns `0`, which is a success, not an error. The count is returned to the
    client so a teardown that quietly matched nothing is visible in the harness's
    own output rather than only in this service's logs.
    """
    return TrackingRepository(session).soft_delete_by_tag(
        tag, actor=AuditActor.E2E_CLEANUP
    )
