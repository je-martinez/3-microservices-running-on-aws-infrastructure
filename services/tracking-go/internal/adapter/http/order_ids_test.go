package http_test

import (
	"reflect"
	"testing"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
)

func TestParseOrderIDs(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"plain", "a,b,c", []string{"a", "b", "c"}},
		{"drops empty parts", "a,,b", []string{"a", "b"}},
		{"drops trailing comma", "a,b,", []string{"a", "b"}},
		{"trims whitespace", " a , b ", []string{"a", "b"}},
		{"dedupes preserving first-seen order", "a,b,a", []string{"a", "b"}},
		{"dedupes across whitespace", "a, a ,b", []string{"a", "b"}},
		{"all empty yields nothing", ",,,", []string{}},
		{"single", "a", []string{"a"}},
		{"the empty string yields nothing", "", []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := adapterhttp.ParseOrderIDs(tc.raw)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("ParseOrderIDs(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// The result must be a NON-NIL slice even when nothing survives parsing: it is
// handed straight to the cache key builder and to the use case, and a nil slice
// there would be indistinguishable from "the caller sent no parameter" at the
// one place where those two cases have different status codes (200 vs 422).
func TestParseOrderIDsNeverReturnsNil(t *testing.T) {
	if got := adapterhttp.ParseOrderIDs(",,,"); got == nil {
		t.Fatal("ParseOrderIDs returned nil; an empty result must be a non-nil empty slice")
	}
}

// De-duplication is what makes the cap count DISTINCT ids. Asserted separately
// from the table above so a regression names the rule it broke.
func TestParseOrderIDsCollapsesDuplicatesBeforeTheCapIsApplied(t *testing.T) {
	raw := ""
	for i := 0; i < 200; i++ {
		if i > 0 {
			raw += ","
		}
		raw += "ord_same"
	}
	if got := adapterhttp.ParseOrderIDs(raw); len(got) != 1 {
		t.Fatalf("200 repetitions of one id parsed to %d ids, want 1", len(got))
	}
}
