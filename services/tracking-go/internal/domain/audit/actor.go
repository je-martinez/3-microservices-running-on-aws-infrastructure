// Package audit holds the semantic actors stamped into created_by / updated_by /
// deleted_by.
//
// Format <source>:<action>, mirroring Orders' AuditActor and Users' enum: the
// value records WHAT PRODUCED THE ROW, not which user id happened to be on the
// request. That matters more here than elsewhere — two of Tracking's three write
// paths have no user identity at all to stamp (the carrier webhook carries no
// x-user-id, and TestMode progression runs on a timer with no request behind it).
//
// Add members when new write paths appear; never widen speculatively.
package audit

// Actor is what produced a row. Stamped by the repository on every write.
type Actor string

const (
	// CreateTracking — POST /v1/trackings/init-tracking, the only way a tracking
	// is created.
	CreateTracking Actor = "tracking_api:create_tracking"
	// CarrierStatusUpdate — PUT /v1/trackings/{orderId}/status, the third-party
	// carrier webhook.
	CarrierStatusUpdate Actor = "tracking_api:carrier_status_update"
	// TestModeProgression — the automatic PLACED -> ... -> DELIVERED walk.
	TestModeProgression Actor = "tracking_api:test_mode_progression"
	// E2ECleanup — DELETE /v1/trackings/e2e-cleanup. Its own actor rather than
	// the caller's identity: a row soft-deleted by the test harness must stay
	// distinguishable from one a real flow removed.
	E2ECleanup Actor = "tracking_api:e2e_cleanup"
	// DeleteByUser — DELETE /v1/trackings/by-user, the account-deletion cascade.
	DeleteByUser Actor = "tracking_api:delete_by_user"
)
