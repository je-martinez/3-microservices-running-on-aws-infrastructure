"""`DELETE /v1/trackings/by-user` command handler.

The Tracking leg of the account-deletion cascade. Transport-free like every other
command here — it takes a session and returns a count, so the router stays a thin
translation.

The actor is the cascade, not the user: `deleted_by` records what produced the
change, and "this account was deleted" is a different fact from "the carrier
updated this" or "the test harness swept this".
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from src.features.tracking.domain.repository import TrackingRepository
from src.shared.audit.audit_actor import AuditActor


def delete_by_user(session: Session, *, cognito_sub: str, user_id: str) -> int:
    """Soft-delete every live tracking owned by the user.

    Returns how many `tracking` rows were stamped.
    """
    return TrackingRepository(session).soft_delete_by_user(
        cognito_sub=cognito_sub,
        user_id=user_id,
        actor=AuditActor.DELETE_BY_USER,
    )
