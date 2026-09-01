package audit_test

import (
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain/audit"
)

// These strings are persisted in created_by/updated_by/deleted_by and read by
// dashboards and cleanup queries. Spelling is the contract.
func TestActorSpellings(t *testing.T) {
	tests := []struct {
		actor audit.Actor
		want  string
	}{
		{audit.CreateTracking, "tracking_api:create_tracking"},
		{audit.CarrierStatusUpdate, "tracking_api:carrier_status_update"},
		{audit.TestModeProgression, "tracking_api:test_mode_progression"},
		{audit.E2ECleanup, "tracking_api:e2e_cleanup"},
		{audit.DeleteByUser, "tracking_api:delete_by_user"},
	}
	for _, tt := range tests {
		if string(tt.actor) != tt.want {
			t.Errorf("actor = %q, want %q", string(tt.actor), tt.want)
		}
	}
}
