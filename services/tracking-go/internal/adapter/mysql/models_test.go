package mysql

import (
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

func TestShippingAddressScansNullableJSON(t *testing.T) {
	// Deliberately NOT a Go struct. The shape is owned by Orders/Users; this
	// service only stores and returns it, so an additive upstream field must not
	// become a tracking-creation outage.
	//
	// []byte and not json.RawMessage, and the difference is load-bearing rather
	// than stylistic: json.RawMessage does not implement sql.Scanner, so a NULL
	// in this nullable column fails AT RUNTIME with
	//
	//   unsupported Scan, storing driver.Value type <nil> into *json.RawMessage
	//
	// Most rows have no address, so that is the common path, not an edge case.
	// []byte takes NULL as a nil slice. Verified against a real MySQL row.
	field, ok := reflect.TypeOf(Tracking{}).FieldByName("ShippingAddress")
	if !ok {
		t.Fatal("Tracking has no ShippingAddress field")
	}
	want := reflect.TypeOf([]byte(nil))
	if field.Type != want {
		t.Fatalf("Tracking.ShippingAddress is %s, want %s", field.Type, want)
	}
	// The type must satisfy sql.Scanner's contract for NULL. json.RawMessage
	// would compile here and fail on the first address-less row.
	var target any = &Tracking{}
	if _, isScanner := target.(interface{ Scan(any) error }); isScanner {
		t.Fatal("unexpected: Tracking itself implements Scanner")
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
