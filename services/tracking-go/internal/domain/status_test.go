package domain

import (
	"errors"
	"testing"
)

func TestStatusOrderIsProgressionNotAlphabetical(t *testing.T) {
	// The guard rail for this entire file: if ordering ever came from comparing
	// the string values, DELIVERED would sort before PLACED.
	//
	// Written as the negation of the alphabetical comparison on purpose: the
	// point being asserted is "alphabetical order says DELIVERED < PLACED", and
	// De Morgan-ing it into `StatusDelivered >= StatusPlaced` inverts the
	// statement the reader is meant to check against the comment above.
	//nolint:staticcheck // QF1001: the un-simplified form documents the trap.
	if !(StatusDelivered < StatusPlaced) {
		t.Fatal("precondition changed: DELIVERED no longer sorts before PLACED as a string")
	}
	dIdx, ok := StatusIndex(StatusDelivered)
	if !ok {
		t.Fatal("StatusIndex(DELIVERED) not found")
	}
	pIdx, ok := StatusIndex(StatusPlaced)
	if !ok {
		t.Fatal("StatusIndex(PLACED) not found")
	}
	if dIdx <= pIdx {
		t.Fatalf("progression index: DELIVERED=%d must be AFTER PLACED=%d", dIdx, pIdx)
	}
}

func TestStatusIndexes(t *testing.T) {
	want := map[Status]int{
		StatusPlaced:         0,
		StatusProcessing:     1,
		StatusShipped:        2,
		StatusOutForDelivery: 3,
		StatusDelivered:      4,
	}
	for s, wantIdx := range want {
		got, ok := StatusIndex(s)
		if !ok {
			t.Errorf("StatusIndex(%s): not found", s)
			continue
		}
		if got != wantIdx {
			t.Errorf("StatusIndex(%s) = %d, want %d", s, got, wantIdx)
		}
	}
	if _, ok := StatusIndex(Status("NOPE")); ok {
		t.Error("StatusIndex(NOPE) reported found; want not found")
	}
}

func TestCheckTransition(t *testing.T) {
	tests := []struct {
		name       string
		current    Status
		requested  Status
		wantAllow  bool
		wantReason RejectionReason
	}{
		// Every legal adjacent transition.
		{"placed to processing", StatusPlaced, StatusProcessing, true, ""},
		{"processing to shipped", StatusProcessing, StatusShipped, true, ""},
		{"shipped to out for delivery", StatusShipped, StatusOutForDelivery, true, ""},
		{"out for delivery to delivered", StatusOutForDelivery, StatusDelivered, true, ""},

		// Skipping is ALLOWED. This is not a next-step-only machine.
		{"skip placed to delivered", StatusPlaced, StatusDelivered, true, ""},
		{"skip placed to shipped", StatusPlaced, StatusShipped, true, ""},
		{"skip processing to delivered", StatusProcessing, StatusDelivered, true, ""},
		{"skip placed to out for delivery", StatusPlaced, StatusOutForDelivery, true, ""},

		// Guard 1 — terminal, checked FIRST. DELIVERED reports already_delivered
		// whatever is requested of it.
		{"delivered to placed", StatusDelivered, StatusPlaced, false, ReasonAlreadyDelivered},
		{"delivered to processing", StatusDelivered, StatusProcessing, false, ReasonAlreadyDelivered},
		{"delivered to shipped", StatusDelivered, StatusShipped, false, ReasonAlreadyDelivered},
		{"delivered to out for delivery", StatusDelivered, StatusOutForDelivery, false, ReasonAlreadyDelivered},
		// The load-bearing case: DELIVERED->DELIVERED violates guards 1 and 3 at
		// once. Guard order decides which is reported, and it must be guard 1.
		{"delivered to delivered", StatusDelivered, StatusDelivered, false, ReasonAlreadyDelivered},

		// Guard 2 — backward.
		{"processing to placed", StatusProcessing, StatusPlaced, false, ReasonBackwardTransition},
		{"shipped to processing", StatusShipped, StatusProcessing, false, ReasonBackwardTransition},
		{"out for delivery to placed", StatusOutForDelivery, StatusPlaced, false, ReasonBackwardTransition},
		{"shipped to placed", StatusShipped, StatusPlaced, false, ReasonBackwardTransition},

		// Guard 3 — equal is not strictly forward.
		{"placed to placed", StatusPlaced, StatusPlaced, false, ReasonNotStrictlyForward},
		{"processing to processing", StatusProcessing, StatusProcessing, false, ReasonNotStrictlyForward},
		{"shipped to shipped", StatusShipped, StatusShipped, false, ReasonNotStrictlyForward},
		{"out for delivery to out for delivery", StatusOutForDelivery, StatusOutForDelivery, false, ReasonNotStrictlyForward},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckTransition(tt.current, tt.requested)
			if got.Allowed != tt.wantAllow {
				t.Fatalf("CheckTransition(%s, %s).Allowed = %v, want %v",
					tt.current, tt.requested, got.Allowed, tt.wantAllow)
			}
			if got.Reason != tt.wantReason {
				t.Fatalf("CheckTransition(%s, %s).Reason = %q, want %q",
					tt.current, tt.requested, got.Reason, tt.wantReason)
			}
			if CanTransition(tt.current, tt.requested) != tt.wantAllow {
				t.Fatalf("CanTransition(%s, %s) disagrees with CheckTransition",
					tt.current, tt.requested)
			}
		})
	}
}

func TestAssertCanTransition(t *testing.T) {
	if err := AssertCanTransition(StatusPlaced, StatusShipped); err != nil {
		t.Fatalf("AssertCanTransition(PLACED, SHIPPED) = %v, want nil", err)
	}

	err := AssertCanTransition(StatusDelivered, StatusDelivered)
	if err == nil {
		t.Fatal("AssertCanTransition(DELIVERED, DELIVERED) = nil, want error")
	}
	var ite *InvalidTransitionError
	if !errors.As(err, &ite) {
		t.Fatalf("error is %T, want *InvalidTransitionError", err)
	}
	if ite.Reason != ReasonAlreadyDelivered {
		t.Errorf("Reason = %q, want %q", ite.Reason, ReasonAlreadyDelivered)
	}
	if ite.Current != StatusDelivered || ite.Requested != StatusDelivered {
		t.Errorf("Current/Requested = %s/%s, want DELIVERED/DELIVERED", ite.Current, ite.Requested)
	}
	want := "cannot transition from DELIVERED to DELIVERED: already_delivered"
	if got := err.Error(); got != want {
		t.Errorf("Error() = %q, want %q", got, want)
	}
}

func TestNextStatus(t *testing.T) {
	tests := []struct {
		current Status
		want    Status
		wantOK  bool
	}{
		{StatusPlaced, StatusProcessing, true},
		{StatusProcessing, StatusShipped, true},
		{StatusShipped, StatusOutForDelivery, true},
		{StatusOutForDelivery, StatusDelivered, true},
		// Reaching the end is how a TestMode run FINISHES. Not an error.
		{StatusDelivered, "", false},
	}
	for _, tt := range tests {
		t.Run(string(tt.current), func(t *testing.T) {
			got, ok := NextStatus(tt.current)
			if ok != tt.wantOK {
				t.Fatalf("NextStatus(%s) ok = %v, want %v", tt.current, ok, tt.wantOK)
			}
			if ok && got != tt.want {
				t.Fatalf("NextStatus(%s) = %s, want %s", tt.current, got, tt.want)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	for _, s := range []Status{
		StatusPlaced, StatusProcessing, StatusShipped, StatusOutForDelivery, StatusDelivered,
	} {
		got, err := ParseStatus(string(s))
		if err != nil {
			t.Errorf("ParseStatus(%q) returned error %v", s, err)
			continue
		}
		if got != s {
			t.Errorf("ParseStatus(%q) = %s, want %s", s, got, s)
		}
	}
}

func TestParseStatusIsCaseSensitive(t *testing.T) {
	// The five values are a fixed wire contract shared with the proto, not
	// free-form input.
	for _, bad := range []string{"placed", "Placed", "delivered", "oUt_FoR_dElIvErY"} {
		if _, err := ParseStatus(bad); err == nil {
			t.Errorf("ParseStatus(%q) = nil error; parsing must be case-sensitive", bad)
		}
	}
}

func TestParseStatusErrorMessageIsExact(t *testing.T) {
	_, err := ParseStatus("FOO")
	if err == nil {
		t.Fatal("ParseStatus(FOO) = nil error, want error")
	}
	want := "invalid tracking status 'FOO'; expected one of: PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED"
	if got := err.Error(); got != want {
		t.Fatalf("Error() =\n  %q\nwant\n  %q", got, want)
	}
}

func TestParseStatusRejectsEmptyString(t *testing.T) {
	if _, err := ParseStatus(""); err == nil {
		t.Fatal("ParseStatus(\"\") = nil error, want error")
	}
}
