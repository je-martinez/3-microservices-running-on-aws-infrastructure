"""Semantic audit actors stamped into `created_by` / `updated_by` / `deleted_by`.

Format `<source>:<action>`, mirroring Orders' `AuditActor` and Users' enum: the
value records **what produced the row**, not which user id happened to be on the
request. This matters more here than elsewhere — two of Tracking's three write
paths have no user identity at all to stamp (the carrier webhook carries no
`x-user-id`, and TestMode progression runs on a timer with no request behind it).

Add members when new write paths appear; never widen speculatively.
"""

from enum import StrEnum


class AuditActor(StrEnum):
    """What produced a row. Stamped by the repository on every write."""

    # POST /v1/trackings/init-tracking — the only way a tracking is created.
    CREATE_TRACKING = "tracking_api:create_tracking"
    # PUT /v1/trackings/{orderId}/status — the third-party carrier webhook.
    CARRIER_STATUS_UPDATE = "tracking_api:carrier_status_update"
    # Automatic TestMode progression (PLACED -> ... -> DELIVERED on a timer).
    TEST_MODE_PROGRESSION = "tracking_api:test_mode_progression"
    # DELETE /v1/trackings/e2e-cleanup — the flag-guarded E2E teardown. Its own
    # actor rather than the caller's identity, matching Orders' `E2eCleanup` and
    # Users' `AuditActor.E2eCleanup`: a row soft-deleted by the test harness must
    # be distinguishable from one a real flow removed, which is the whole reason
    # `deleted_by` records a source rather than a user id.
    E2E_CLEANUP = "tracking_api:e2e_cleanup"
