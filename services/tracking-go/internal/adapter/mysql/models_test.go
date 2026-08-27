package mysql

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/mysql/tagtype"
)

// The two sqlc overrides are configuration, not code, so nothing else in the
// package would fail if either were dropped from sqlc.yaml — the generated
// models would simply come back with different field types and every call site
// would quietly adapt. These assertions make a lost override a test failure.

func TestTagsColumnUsesTheHandWrittenType(t *testing.T) {
	// Without the override sqlc yields json.RawMessage here, which pushes JSON
	// marshalling into every call site instead of keeping it in the Scanner and
	// Valuer on tagtype.Tags.
	field, ok := reflect.TypeOf(Tracking{}).FieldByName("Tags")
	if !ok {
		t.Fatal("Tracking has no Tags field")
	}
	want := reflect.TypeOf(tagtype.Tags(nil))
	if field.Type != want {
		t.Fatalf("Tracking.Tags is %s, want %s", field.Type, want)
	}
}

func TestShippingAddressStaysRawJSON(t *testing.T) {
	// Deliberately NOT a Go struct. The shape is owned by Orders/Users; this
	// service only stores and returns it, so an additive upstream field must not
	// become a tracking-creation outage.
	field, ok := reflect.TypeOf(Tracking{}).FieldByName("ShippingAddress")
	if !ok {
		t.Fatal("Tracking has no ShippingAddress field")
	}
	want := reflect.TypeOf(json.RawMessage(nil))
	if field.Type != want {
		t.Fatalf("Tracking.ShippingAddress is %s, want %s", field.Type, want)
	}
}

// tracking_history deliberately carries neither of them: the address is fixed
// for a tracking's lifetime, so snapshotting it per transition would store the
// same JSON five times.
func TestTrackingHistoryHasNoAddressOrTags(t *testing.T) {
	historyType := reflect.TypeOf(TrackingHistory{})
	for _, absent := range []string{"ShippingAddress", "Tags"} {
		if _, found := historyType.FieldByName(absent); found {
			t.Errorf("TrackingHistory has a %s field; it is omitted on purpose", absent)
		}
	}
}
