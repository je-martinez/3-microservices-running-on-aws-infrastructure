package bus_test

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jemartinez/3mrai/services/tracking-go/internal/bus"
)

// The routine-vs-thrown distinction, at the level of the classifier alone. The
// pipeline tests assert the SPAN and the LOG; these assert the decision those
// two read from, so a regression names the classifier rather than the behavior.

var errBoom = errors.New("database is on fire")

func TestClassifyGivesAnUnknownErrorTheThrownOutcome(t *testing.T) {
	got := bus.Classify(errBoom)

	if !got.Failed {
		t.Error("Failed = false, want true: an error is a failure")
	}
	if !got.Thrown {
		t.Error("Thrown = false, want true: an unrecognised error is a genuine fault")
	}
	if got.Reason != bus.ReasonUnhandledError {
		t.Errorf("Reason = %q, want %q", got.Reason, bus.ReasonUnhandledError)
	}
}

func TestClassifyGivesNilTheSucceededOutcome(t *testing.T) {
	got := bus.Classify(nil)

	if got.Failed {
		t.Error("Failed = true, want false")
	}
	if got.Thrown {
		t.Error("Thrown = true, want false")
	}
	if got.Reason != "" {
		t.Errorf("Reason = %q, want empty: `reason` is OMITTED on success, never null", got.Reason)
	}
}

// The load-bearing case. A domain "not found" a route turns into a 404 is a
// NORMAL RETURN VALUE: it must log *_failed with its reason and leave the span
// status alone.
func TestClassifyGivesARoutineFailureItsReasonWithoutMarkingItThrown(t *testing.T) {
	got := bus.Classify(bus.Routine(errors.New("tracking not found"), "not_found"))

	if !got.Failed {
		t.Error("Failed = false, want true: a routine failure still logs *_failed")
	}
	if got.Thrown {
		t.Error("Thrown = true, want false: a 404 is not a span-ERROR fault")
	}
	if got.Reason != "not_found" {
		t.Errorf("Reason = %q, want %q", got.Reason, "not_found")
	}
}

// The classifier must see through a wrap: a use case that adds context with %w
// must not silently promote a routine failure to a fault.
func TestClassifySeesARoutineFailureThroughAWrap(t *testing.T) {
	wrapped := fmt.Errorf("reading tracking: %w", bus.Routine(errBoom, "already_delivered"))

	got := bus.Classify(wrapped)

	if got.Thrown {
		t.Error("Thrown = true, want false: errors.As must reach the wrapped routine failure")
	}
	if got.Reason != "already_delivered" {
		t.Errorf("Reason = %q, want %q", got.Reason, "already_delivered")
	}
}

// Routine must not swallow the cause: the route still matches on the sentinel
// with errors.Is to choose its status code.
func TestRoutinePreservesTheUnderlyingErrorForErrorsIs(t *testing.T) {
	err := bus.Routine(errBoom, "not_found")

	if !errors.Is(err, errBoom) {
		t.Error("errors.Is could not reach the cause: the route cannot pick its status code")
	}
	if err.Error() != errBoom.Error() {
		t.Errorf("Error() = %q, want the cause's own text %q", err.Error(), errBoom.Error())
	}
}

// A reason is the entire point of the wrapper, so an empty one is a programming
// error that must not reach a log line as `"reason":""`.
func TestRoutineWithoutAReasonFallsBackToTheUnhandledToken(t *testing.T) {
	got := bus.Classify(bus.Routine(errBoom, ""))

	if got.Reason != bus.ReasonUnhandledError {
		t.Errorf("Reason = %q, want %q: an empty reason must never be emitted", got.Reason, bus.ReasonUnhandledError)
	}
}
