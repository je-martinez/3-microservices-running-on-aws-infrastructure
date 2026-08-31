package domain

import (
	"testing"
	"time"
)

func TestSortHistoryOrdersByDatetimeThenProgression(t *testing.T) {
	early := time.Date(2026, 8, 27, 10, 0, 0, 0, time.UTC)
	later := time.Date(2026, 8, 27, 11, 0, 0, 0, time.UTC)

	history := []TrackingHistory{
		{TrackingID: "trk_a", Status: StatusShipped, Datetime: later},
		{TrackingID: "trk_a", Status: StatusPlaced, Datetime: early},
		{TrackingID: "trk_a", Status: StatusProcessing, Datetime: early},
	}

	SortHistory(history)

	want := []Status{StatusPlaced, StatusProcessing, StatusShipped}
	for i, wantStatus := range want {
		if history[i].Status != wantStatus {
			t.Fatalf("history[%d].Status = %s, want %s (full order: %v)",
				i, history[i].Status, wantStatus, statusesOf(history))
		}
	}
}

// The regression this ordering exists for. Two rows sharing a datetime is not
// hypothetical: DATETIME here has fsp 0 (second resolution) and a single unit of
// work stamps every row it writes from one `now`. With a bare datetime sort,
// MySQL falls back to primary-key order — (tracking_id, status), i.e.
// ALPHABETICAL — and DELIVERED would come out first.
func TestSortHistoryTiebreakerOnIdenticalTimestamps(t *testing.T) {
	sameInstant := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	// Deliberately seeded in the order MySQL's PK order would return them:
	// DELIVERED before PLACED. If the tiebreaker is missing, a stable sort
	// leaves them exactly like this and the test fails.
	history := []TrackingHistory{
		{TrackingID: "trk_a", Status: StatusDelivered, Datetime: sameInstant},
		{TrackingID: "trk_a", Status: StatusPlaced, Datetime: sameInstant},
	}

	SortHistory(history)

	if history[0].Status != StatusPlaced {
		t.Fatalf("history[0].Status = %s, want PLACED — a shipment cannot be delivered before it is placed",
			history[0].Status)
	}
	if history[1].Status != StatusDelivered {
		t.Fatalf("history[1].Status = %s, want DELIVERED", history[1].Status)
	}
}

func TestSortHistoryFullAlphabeticalPKOrderIsCorrected(t *testing.T) {
	sameInstant := time.Date(2026, 8, 27, 12, 0, 0, 0, time.UTC)

	// All five, seeded in exactly the alphabetical order MySQL's PK would yield.
	history := []TrackingHistory{
		{Status: StatusDelivered, Datetime: sameInstant},
		{Status: StatusOutForDelivery, Datetime: sameInstant},
		{Status: StatusPlaced, Datetime: sameInstant},
		{Status: StatusProcessing, Datetime: sameInstant},
		{Status: StatusShipped, Datetime: sameInstant},
	}

	SortHistory(history)

	want := []Status{
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	}
	for i, wantStatus := range want {
		if history[i].Status != wantStatus {
			t.Fatalf("history[%d].Status = %s, want %s (full order: %v)",
				i, history[i].Status, wantStatus, statusesOf(history))
		}
	}
}

func TestSortHistoryHandlesEmptyAndSingle(t *testing.T) {
	var empty []TrackingHistory
	SortHistory(empty) // must not panic

	one := []TrackingHistory{{Status: StatusPlaced, Datetime: time.Now().UTC()}}
	SortHistory(one)
	if len(one) != 1 || one[0].Status != StatusPlaced {
		t.Fatalf("single-element slice was disturbed: %v", statusesOf(one))
	}
}

func TestTrackingIsDeleted(t *testing.T) {
	live := Tracking{ID: "trk_live"}
	if live.IsDeleted() {
		t.Error("IsDeleted() = true for a tracking with a nil DeletedAt")
	}

	at := time.Date(2026, 8, 27, 9, 0, 0, 0, time.UTC)
	gone := Tracking{ID: "trk_gone", DeletedAt: &at}
	if !gone.IsDeleted() {
		t.Error("IsDeleted() = false for a tracking with a set DeletedAt")
	}
}

func TestTrackingHasTag(t *testing.T) {
	tagged := Tracking{Tags: []string{E2ESourceTag}}
	if !tagged.HasTag(E2ESourceTag) {
		t.Errorf("HasTag(%q) = false, want true", E2ESourceTag)
	}
	// Matching is exact. Users' teardown selects on this same literal, and a
	// near-miss would clean up nothing while looking correct.
	if tagged.HasTag("e2e-source") {
		t.Error(`HasTag("e2e-source") = true; matching must be exact`)
	}
	if tagged.HasTag("E2E SOURCE") {
		t.Error(`HasTag("E2E SOURCE") = true; matching must be case-sensitive`)
	}

	untagged := Tracking{Tags: []string{}}
	if untagged.HasTag(E2ESourceTag) {
		t.Error("HasTag on an empty tag slice = true, want false")
	}

	var nilTags Tracking
	if nilTags.HasTag(E2ESourceTag) {
		t.Error("HasTag on nil Tags = true, want false")
	}
}

func TestE2ESourceTagLiteralIsExact(t *testing.T) {
	// Shared VERBATIM with Users. Do not "normalize" it.
	if E2ESourceTag != "E2E Source" {
		t.Fatalf("E2ESourceTag = %q, want %q", E2ESourceTag, "E2E Source")
	}
}

func TestColumnWidthConstants(t *testing.T) {
	if IDLength != 28 {
		t.Errorf("IDLength = %d, want 28 (prefix 4 + nano 24)", IDLength)
	}
	if StatusLength != 50 {
		t.Errorf("StatusLength = %d, want 50", StatusLength)
	}
	if CognitoSubLength != 255 {
		t.Errorf("CognitoSubLength = %d, want 255", CognitoSubLength)
	}
}

func statusesOf(history []TrackingHistory) []Status {
	out := make([]Status, len(history))
	for i, h := range history {
		out[i] = h.Status
	}
	return out
}
