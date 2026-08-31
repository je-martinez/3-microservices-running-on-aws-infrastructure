package tagtype

import (
	"database/sql/driver"
	"testing"
)

func TestTagsValueMarshalsToJSONArray(t *testing.T) {
	tests := []struct {
		name string
		tags Tags
		want string
	}{
		// NEVER NULL and never "": the column is NOT NULL with a
		// DEFAULT (JSON_ARRAY()), and JSON_CONTAINS(NULL, ...) is NULL rather
		// than FALSE, which would silently exclude the row from the e2e-cleanup
		// predicate.
		{"nil renders as empty array", nil, `[]`},
		{"empty renders as empty array", Tags{}, `[]`},
		{"single tag", Tags{"E2E Source"}, `["E2E Source"]`},
		{"several tags", Tags{"E2E Source", "other"}, `["E2E Source","other"]`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.tags.Value()
			if err != nil {
				t.Fatalf("Value() error = %v", err)
			}
			b, ok := got.([]byte)
			if !ok {
				t.Fatalf("Value() returned %T, want []byte", got)
			}
			if string(b) != tt.want {
				t.Fatalf("Value() = %s, want %s", b, tt.want)
			}
		})
	}
}

func TestTagsScan(t *testing.T) {
	tests := []struct {
		name string
		src  any
		want Tags
	}{
		{"empty array bytes", []byte(`[]`), Tags{}},
		{"single tag bytes", []byte(`["E2E Source"]`), Tags{"E2E Source"}},
		{"several tags bytes", []byte(`["a","b"]`), Tags{"a", "b"}},
		{"string source", `["E2E Source"]`, Tags{"E2E Source"}},
		// The column is NOT NULL, but a driver can still hand us nil for a row
		// written before the constraint existed. Degrade to empty, never panic.
		{"nil source", nil, Tags{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got Tags
			if err := got.Scan(tt.src); err != nil {
				t.Fatalf("Scan(%v) error = %v", tt.src, err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("Scan(%v) = %v, want %v", tt.src, got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Fatalf("Scan(%v)[%d] = %q, want %q", tt.src, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestTagsScanRejectsUnsupportedType(t *testing.T) {
	var tags Tags
	if err := tags.Scan(42); err == nil {
		t.Fatal("Scan(42) = nil error, want an error")
	}
}

func TestTagsRoundTrip(t *testing.T) {
	original := Tags{"E2E Source"}
	encoded, err := original.Value()
	if err != nil {
		t.Fatalf("Value() error = %v", err)
	}
	var decoded Tags
	if err := decoded.Scan(encoded); err != nil {
		t.Fatalf("Scan() error = %v", err)
	}
	if len(decoded) != 1 || decoded[0] != "E2E Source" {
		t.Fatalf("round trip = %v, want [E2E Source]", decoded)
	}
}

// Compile-time proof that Tags satisfies both database/sql interfaces. sqlc's
// override is only correct if it does.
var (
	_ driver.Valuer = Tags(nil)
)
