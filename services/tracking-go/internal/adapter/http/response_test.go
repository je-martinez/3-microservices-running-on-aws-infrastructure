package http_test

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	adapterhttp "github.com/jemartinez/3mrai/services/tracking-go/internal/adapter/http"
	"github.com/jemartinez/3mrai/services/tracking-go/internal/domain"
)

func TestISO(t *testing.T) {
	cases := []struct {
		name string
		in   *time.Time
		want string
	}{
		{"nil renders as the empty string, never null", nil, ""},
		{"the zero time renders as the empty string", initPtr(time.Time{}), ""},
		{
			"whole seconds carry no fractional part",
			initPtr(time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)),
			"2026-08-27T14:53:01Z",
		},
		{
			"microseconds are rendered without trailing zeros",
			initPtr(time.Date(2026, 8, 27, 14, 53, 1, 123456000, time.UTC)),
			"2026-08-27T14:53:01.123456Z",
		},
		{
			"a trailing-zero fraction is trimmed the way isoformat does",
			initPtr(time.Date(2026, 8, 27, 14, 53, 1, 500000000, time.UTC)),
			"2026-08-27T14:53:01.5Z",
		},
		{
			// Python's isoformat() caps at MICROseconds; Go's time carries
			// nanoseconds. RFC3339Nano would emit ".123456789" here — a precision no
			// Python client has ever received. This is the ONE case that
			// distinguishes the two layouts, because for every microsecond-aligned
			// value they agree exactly.
			"nanoseconds are truncated to microseconds, as isoformat does",
			initPtr(time.Date(2026, 8, 27, 14, 53, 1, 123456789, time.UTC)),
			"2026-08-27T14:53:01.123456Z",
		},
		{
			// A non-UTC moment must be converted, not labelled: appending "Z" to a
			// local rendering would move the instant by the offset.
			"a non-UTC moment is converted to UTC before the Z is appended",
			initPtr(time.Date(2026, 8, 27, 14, 53, 1, 0, time.FixedZone("x", 2*60*60))),
			"2026-08-27T12:53:01Z",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := adapterhttp.ISO(tc.in); got != tc.want {
				t.Errorf("ISO() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestISOIsNotRFC3339(t *testing.T) {
	// Both RFC3339 layouts are near-misses, and each is wrong in its own way:
	// RFC3339 DROPS the fraction entirely, RFC3339Nano emits NANOsecond precision
	// that Python's isoformat() never produces. They agree with ISO on every
	// whole-second value, which is why the moment below deliberately carries
	// nanoseconds — a probe without them proves nothing.
	moment := time.Date(2026, 8, 27, 14, 53, 1, 123456789, time.UTC)
	got := adapterhttp.ISO(&moment)
	for name, layout := range map[string]string{
		"RFC3339":     time.RFC3339,
		"RFC3339Nano": time.RFC3339Nano,
	} {
		if got == moment.Format(layout) {
			t.Errorf("ISO() produced the %s rendering %q; the Python emits isoformat()+Z",
				name, got)
		}
	}
}

func TestTrackingResponseCannotHoldPII(t *testing.T) {
	// A structural assertion, not a behavioural one: the response types must be
	// PHYSICALLY incapable of carrying shipping_address or cognito_sub, so no
	// future edit can leak them by populating a field that already exists.
	for _, typ := range []reflect.Type{
		reflect.TypeOf(adapterhttp.TrackingResponse{}),
		reflect.TypeOf(adapterhttp.HistoryEntryResponse{}),
	} {
		for i := range typ.NumField() {
			name := strings.ToLower(typ.Field(i).Name)
			if strings.Contains(name, "shipping") || strings.Contains(name, "cognito") {
				t.Errorf("%s.%s must not exist", typ.Name(), typ.Field(i).Name)
			}
		}
	}
}

func TestNewTrackingResponse(t *testing.T) {
	now := time.Date(2026, 8, 27, 14, 53, 1, 0, time.UTC)
	got := adapterhttp.NewTrackingResponse(domain.TrackingWithHistory{
		Tracking: domain.Tracking{
			ID: "trk_1", UserID: "usr_internal", OrderID: "ord_1",
			CognitoSub: "sub-abc", Status: domain.StatusPlaced, Datetime: now,
			ShippingAddress: []byte(`{"street":"a"}`),
		},
		History: []domain.TrackingHistory{{
			TrackingID: "trk_1", UserID: "usr_internal", OrderID: "ord_1",
			CognitoSub: "sub-abc", Status: domain.StatusPlaced, Datetime: now,
		}},
	})

	if got.UserID != "usr_internal" {
		t.Errorf("user_id = %q, want the internal usr_ id", got.UserID)
	}
	if got.Datetime != "2026-08-27T14:53:01Z" {
		t.Errorf("datetime = %q", got.Datetime)
	}
	if len(got.History) != 1 || got.History[0].Datetime != "2026-08-27T14:53:01Z" {
		t.Errorf("history = %+v", got.History)
	}

	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"shipping_address", "cognito_sub", "street", "sub-abc"} {
		if strings.Contains(string(raw), forbidden) {
			t.Errorf("the response leaks %q: %s", forbidden, raw)
		}
	}
}

func TestEmptyHistoryMarshalsAsArrayNotNull(t *testing.T) {
	got := adapterhttp.NewTrackingResponse(domain.TrackingWithHistory{
		Tracking: domain.Tracking{ID: "trk_1", Status: domain.StatusPlaced},
	})
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"history":[]`) {
		t.Errorf("empty history marshalled as %s, want []", raw)
	}
	// Omitted, never null: an unknown timestamp is "" on this contract.
	if !strings.Contains(string(raw), `"datetime":""`) {
		t.Errorf("a zero datetime marshalled as %s, want \"\"", raw)
	}
}

func TestErrorShapesStayDistinct(t *testing.T) {
	flat, err := json.Marshal(adapterhttp.FlatError{Detail: "d"})
	if err != nil {
		t.Fatal(err)
	}
	if string(flat) != `{"detail":"d"}` {
		t.Errorf("Shape A = %s", flat)
	}

	nested, err := json.Marshal(adapterhttp.NestedError{
		Detail: adapterhttp.NestedErrorBody{Detail: "d", Reason: "r"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(nested) != `{"detail":{"detail":"d","reason":"r"}}` {
		t.Errorf("Shape B = %s, want the NESTED body", nested)
	}

	reason, err := json.Marshal(adapterhttp.ReasonError{Detail: "d", Reason: "r"})
	if err != nil {
		t.Fatal(err)
	}
	if string(reason) != `{"detail":"d","reason":"r"}` {
		t.Errorf("Shape C = %s", reason)
	}

	validation, err := json.Marshal(
		adapterhttp.NewValidationError([]string{"body", "order_id"}, "m", "t"))
	if err != nil {
		t.Fatal(err)
	}
	if string(validation) != `{"detail":[{"loc":["body","order_id"],"msg":"m","type":"t"}]}` {
		t.Errorf("Shape D = %s", validation)
	}
}
